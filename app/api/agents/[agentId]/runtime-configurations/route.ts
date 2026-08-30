import { NextResponse } from 'next/server';
import {
  activateAgentRuntimeConfiguration,
  createAgentRuntimeConfiguration,
  deleteAgentRuntimeConfiguration,
  getAgentRuntimeSettings,
  getFlowAgentDefaultRuntimeSettings,
  inheritFlowRuntimeConfiguration,
  listAgentRuntimeConfigurations,
  saveAgentRuntimeConfiguration,
} from '../../../../../src/application/project-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function response(agentId: string) {
  return NextResponse.json({
    configurations: listAgentRuntimeConfigurations(agentId),
    effective: await getAgentRuntimeSettings(agentId),
    flowDefault: await getFlowAgentDefaultRuntimeSettings(),
  });
}

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try { return response((await context.params).agentId); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || '');
    if (action === 'create') {
      await createAgentRuntimeConfiguration({ agentId, name: body.name, fromConfigurationId: body.fromConfigurationId });
    } else if (action === 'save') {
      await saveAgentRuntimeConfiguration({
        agentId,
        configurationId: body.configurationId,
        name: body.name,
        executorId: body.executorId,
        codexModel: body.codexModel,
        codexReasoningEffort: body.codexReasoningEffort,
        codexWebSearch: body.codexWebSearch,
        claudeModel: body.claudeModel,
        ompModel: body.ompModel,
        ompThinking: body.ompThinking,
      });
    } else if (action === 'activate') {
      await activateAgentRuntimeConfiguration({ agentId, configurationId: body.configurationId });
    } else if (action === 'inherit') {
      await inheritFlowRuntimeConfiguration(agentId);
    } else if (action === 'delete') {
      await deleteAgentRuntimeConfiguration({ agentId, configurationId: body.configurationId });
    } else throw new Error('未知 Runtime 配置操作');
    return response(agentId);
  } catch (error) { return errorResponse(error); }
}
