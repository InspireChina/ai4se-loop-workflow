import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { discoverExternalCommandPrompts, externalCommandPromptPath, loadExternalCommandPrompt } from './external-command-prompts';
import { documentBodyPath, readDocumentBody, setDocumentFilesRoot, storeDocumentBody } from './document-files';

mkdirSync(process.env.LOOP_DATA_ROOT!,{recursive:true});
const root=mkdtempSync(join(process.env.LOOP_DATA_ROOT!, 'external-'));
mkdirSync(join(root,'.omp','commands'),{recursive:true});
test('loads OMP command Markdown, parses metadata and refreshes edits without a DB overlay',async()=>{
 const file=externalCommandPromptPath(root,'dev-agent');
 writeFileSync(file,'---\nname: dev-agent\nmodel: provider/model\n---\n# External role\nRead ../skills/delivery/SKILL.md and template.md.');
 const original=loadExternalCommandPrompt(root,'dev-agent');assert.equal(original.metadata.model,'provider/model');assert.match(original.prompt,/External role/);assert.ok(!original.prompt.includes('name: dev-agent'));
 const {loadAgentRuntime,getAgentProfile,saveAgentPrompt}=await import('../application/agent-profiles');
 const projectId='PRJ-default';
 const runtimeFile=externalCommandPromptPath(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,'dev-agent');
 writeFileSync(runtimeFile,readFileSync(file,'utf8'));
 const initial=await loadAgentRuntime('dev-agent','dev',projectId);assert.match(initial.prompt,/External role/);assert.equal(initial.evolutionCandidateId,null);
 await assert.rejects(()=>saveAgentPrompt({projectId,agentId:'dev-agent',content:'DB overwrite'}),/外部/);
 writeFileSync(file,'# Updated external role\nUse referenced-template.md.');writeFileSync(runtimeFile,readFileSync(file,'utf8'));
 const updated=await loadAgentRuntime('dev-agent','dev',projectId);assert.match(updated.prompt,/Updated external role/);assert.notEqual(updated.promptHash,initial.promptHash);
 const preview=await getAgentProfile('dev-agent',true,projectId);assert.equal(preview.currentPrompt.content,loadExternalCommandPrompt(root,'dev-agent').prompt);assert.equal(preview.externalCommandPromptPath,realpathSync(runtimeFile));
 assert.equal(existsSync(join(preview.runtimeDirectory,'PROMPT.md')),false);
 const {databaseConnection}=await import('./database'); const db=await databaseConnection();
 assert.equal((db.prepare("SELECT COUNT(*) FROM agent_prompts WHERE content <> ''").pluck().get()),0);
 assert.equal((db.prepare("SELECT COUNT(*) FROM project_agent_overlays WHERE content <> ''").pluck().get()),0);
});
test('missing, invalid, or empty external commands fail explicitly without a built-in fallback',()=>{
 assert.throws(()=>loadExternalCommandPrompt(root,'missing-agent'),/Command 定义不存在/);
 assert.throws(()=>externalCommandPromptPath(root,'../outside'),/ID 无效/);
 const file=externalCommandPromptPath(root,'invalid-agent');writeFileSync(file,'---\nname: invalid\n');assert.throws(()=>loadExternalCommandPrompt(root,'invalid-agent'),/未闭合/);
 writeFileSync(file,'---\nname: invalid-agent\n---\n');assert.throws(()=>loadExternalCommandPrompt(root,'invalid-agent'),/不能为空/);
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


test('native discovery uses root filenames, ignores subagents and nested templates, and refreshes edits',()=>{
 const working=join(root,'scan');mkdirSync(join(working,'.omp','commands','team'),{recursive:true});
 mkdirSync(join(working,'.omp','agents'),{recursive:true});
 writeFileSync(join(working,'.omp','commands','team','dev-agent.md'),'Nested template');
 writeFileSync(join(working,'.omp','agents','dev-agent.md'),'Real OMP subagent');
 assert.equal(discoverExternalCommandPrompts(working).length,0);
 assert.throws(()=>loadExternalCommandPrompt(working,'dev-agent'),/定义不存在/);
 const file=externalCommandPromptPath(working,'dev-agent');
 writeFileSync(file,'---\nname: dev-agent\n---\nExternal implementation command');
 assert.equal(loadExternalCommandPrompt(working,'dev-agent').path,file);
 assert.equal(discoverExternalCommandPrompts(working)[0].id,'dev-agent');
 writeFileSync(file,'---\nname: other-command\n---\nInvalid alias');
 assert.throws(()=>loadExternalCommandPrompt(working,'dev-agent'),/必须与文件名一致/);
 writeFileSync(file,'Use $ARGUMENTS');
 assert.throws(()=>loadExternalCommandPrompt(working,'dev-agent'),/不使用参数占位符/);
 unlinkSync(file);assert.equal(discoverExternalCommandPrompts(working).length,0);
 assert.throws(()=>loadExternalCommandPrompt(working,'dev-agent'),/定义不存在/);
 assert.throws(()=>loadExternalCommandPrompt(join(root,'no-commands-directory'),'dev-agent'),/定义不存在/);
});

test('extra external definitions do not create Workflow roles or change fixed Agent identities', async () => {
 const { FLOW_AGENT_IDS } = await import('../domain/agent-profile');
 const { listAgentProfiles, loadAgentRuntime } = await import('../application/agent-profiles');
 const workspace=process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!;
 writeFileSync(join(workspace,'.omp','commands','custom-role.md'),'---\nname: custom-role\n---\nCustom OMP subtask role');
 assert.ok(discoverExternalCommandPrompts(workspace).some(agent=>agent.id==='custom-role'));
 assert.deepEqual(new Set((await listAgentProfiles()).map(agent=>agent.agent_id)),new Set(FLOW_AGENT_IDS));
 await assert.rejects(loadAgentRuntime('custom-role'),/未知 Agent/);
});
