import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { discoverExternalAgents, externalAgentPath, loadExternalAgent } from './external-agents';
import { documentBodyPath, readDocumentBody, setDocumentFilesRoot, storeDocumentBody } from './document-files';

mkdirSync(process.env.LOOP_DATA_ROOT!,{recursive:true});
const root=mkdtempSync(join(process.env.LOOP_DATA_ROOT!, 'external-'));
mkdirSync(join(root,'.omp','agents'),{recursive:true});
test('loads OMP agent Markdown, parses metadata and refreshes edits without a DB overlay',async()=>{
 const file=externalAgentPath(root,'dev-agent');
 writeFileSync(file,'---\nname: dev-agent\nmodel: provider/model\n---\n# External role\nRead ../skills/delivery/SKILL.md and template.md.');
 const original=loadExternalAgent(root,'dev-agent');assert.equal(original.metadata.model,'provider/model');assert.match(original.prompt,/External role/);assert.ok(!original.prompt.includes('name: dev-agent'));
 const {loadAgentRuntime,getAgentProfile,saveAgentPrompt}=await import('../application/agent-profiles');
 const projectId='PRJ-default';
 const runtimeFile=externalAgentPath(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,'dev-agent');
 writeFileSync(runtimeFile,readFileSync(file,'utf8'));
 const initial=await loadAgentRuntime('dev-agent','dev',projectId);assert.match(initial.prompt,/External role/);assert.equal(initial.evolutionCandidateId,null);
 await assert.rejects(()=>saveAgentPrompt({projectId,agentId:'dev-agent',content:'DB overwrite'}),/外部/);
 writeFileSync(file,'# Updated external role\nUse referenced-template.md.');writeFileSync(runtimeFile,readFileSync(file,'utf8'));
 const updated=await loadAgentRuntime('dev-agent','dev',projectId);assert.match(updated.prompt,/Updated external role/);assert.notEqual(updated.promptHash,initial.promptHash);
 const preview=await getAgentProfile('dev-agent',true,projectId);assert.equal(preview.currentPrompt.content,loadExternalAgent(root,'dev-agent').prompt);assert.equal(preview.externalAgentPath,realpathSync(runtimeFile));
 assert.equal(existsSync(join(preview.runtimeDirectory,'PROMPT.md')),false);
 const {databaseConnection}=await import('./database'); const db=await databaseConnection();
 assert.equal((db.prepare("SELECT COUNT(*) FROM agent_prompts WHERE content <> ''").pluck().get()),0);
 assert.equal((db.prepare("SELECT COUNT(*) FROM project_agent_overlays WHERE content <> ''").pluck().get()),0);
});
test('missing, invalid, or empty external agents fail explicitly without a built-in fallback',()=>{
 assert.throws(()=>loadExternalAgent(root,'missing-agent'),/Agent 定义不存在/);
 assert.throws(()=>externalAgentPath(root,'../outside'),/ID 无效/);
 const file=externalAgentPath(root,'invalid-agent');writeFileSync(file,'---\nname: invalid\n');assert.throws(()=>loadExternalAgent(root,'invalid-agent'),/未闭合/);
 writeFileSync(file,'---\nname: invalid\n---\n');assert.throws(()=>loadExternalAgent(root,'invalid-agent'),/不能为空/);
});
test('document bodies are files, immutable versions survive rollback, and directory changes preserve old reads',async()=>{
 const {createTask,upsertDocument,getDocument,addDocumentComment,getTask}=await import('../application/tasks');
 const {databaseConnection}=await import('./database');
 const task=await createTask({title:'File-backed documents'});
 const id=await upsertDocument({taskId:task,kind:'design',title:'Design',content:'first file body'});
 const db=await databaseConnection();const raw=db.prepare('SELECT content FROM documents WHERE document_id=?').pluck().get(id) as string;
 assert.ok(raw.startsWith('@loopwork-document-file:'));assert.ok(!raw.includes('first file body'));
 assert.equal(readFileSync(documentBodyPath(raw)!,'utf8'),'first file body');
 assert.equal((await getDocument(task,'design'))?.content,'first file body');
 assert.throws(()=>db.transaction(()=>{const orphan=storeDocumentBody(task,id,'uncommitted body');db.prepare('UPDATE documents SET content=? WHERE document_id=?').run(orphan,id);throw new Error('rollback');})(),/rollback/);
 assert.equal((await getDocument(task,'design'))?.content,'first file body');
 await addDocumentComment({taskId:task,documentId:id,anchorType:'selection',quotedText:'first file',content:'Comment works',intent:'note'});
 assert.equal((await getTask(task))?.documents.find(d=>d.document_id===id)?.content,'first file body');
 const nextRoot=join(root,'outputs');setDocumentFilesRoot(nextRoot);
 await upsertDocument({taskId:task,kind:'design',title:'Design',content:'second file body'});
 assert.equal((await getDocument(task,'design'))?.content,'second file body');assert.equal(readDocumentBody(raw),'first file body');
 assert.ok(documentBodyPath(storeDocumentBody(task,id,'third file body'))!.startsWith(realpathSync(nextRoot)));
});


test('discovers frontmatter-named agents, refreshes add/remove and rejects duplicate identities',()=>{
 const working=join(root,'scan');mkdirSync(join(working,'.omp','agents','team'),{recursive:true});
 const file=join(working,'.omp','agents','team','implementation.md');
 assert.equal(discoverExternalAgents(working).length,0);
 writeFileSync(file,'---\nname: dev-agent\n---\nExternal implementation role');
 assert.equal(loadExternalAgent(working,'dev-agent').path,file);
 assert.equal(discoverExternalAgents(working)[0].id,'dev-agent');
 const duplicate=join(working,'.omp','agents','dev-agent.md');writeFileSync(duplicate,'Duplicate');
 assert.throws(()=>loadExternalAgent(working,'dev-agent'),/重复/);
 unlinkSync(duplicate);assert.equal(loadExternalAgent(working,'dev-agent').prompt,'External implementation role');
 unlinkSync(file);assert.equal(discoverExternalAgents(working).length,0);
 assert.throws(()=>loadExternalAgent(working,'dev-agent'),/定义不存在/);
 // The service repository contains dev-agent.md; it must never be a fallback.
 assert.throws(()=>loadExternalAgent(join(root,'no-agents-directory'),'dev-agent'),/定义不存在/);
});

test('extra external definitions do not create Workflow roles or change fixed Agent identities', async () => {
 const { FLOW_AGENT_IDS } = await import('../domain/agent-profile');
 const { listAgentProfiles, loadAgentRuntime } = await import('../application/agent-profiles');
 const workspace=process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!;
 writeFileSync(join(workspace,'.omp','agents','custom-role.md'),'---\nname: custom-role\n---\nCustom OMP subtask role');
 assert.ok(discoverExternalAgents(workspace).some(agent=>agent.id==='custom-role'));
 assert.deepEqual(new Set((await listAgentProfiles()).map(agent=>agent.agent_id)),new Set(FLOW_AGENT_IDS));
 await assert.rejects(loadAgentRuntime('custom-role'),/未知 Agent/);
});
