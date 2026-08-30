import { NextResponse } from 'next/server';
import { activateAgentConfiguration, createAgentConfiguration, deleteAgentConfiguration, listAgentConfigurations, renameAgentConfiguration, saveAgentConfigurationDocument } from '../../../../../src/application/agent-configurations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    return NextResponse.json({ configurations: listAgentConfigurations(agentId) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || '');
    if (action === 'create') createAgentConfiguration({ agentId, name: body.name, fromConfigurationId: body.fromConfigurationId });
    else if (action === 'rename') renameAgentConfiguration({ agentId, configurationId: body.configurationId, name: body.name });
    else if (action === 'activate') activateAgentConfiguration({ agentId, configurationId: body.configurationId });
    else if (action === 'delete') deleteAgentConfiguration({ agentId, configurationId: body.configurationId });
    else if (action === 'save') saveAgentConfigurationDocument({ agentId, configurationId: body.configurationId, commandChainId: body.commandChainId, yaml: body.yaml });
    else throw new Error('未知 Agent 配置操作');
    return NextResponse.json({ configurations: listAgentConfigurations(agentId) });
  } catch (error) { return errorResponse(error); }
}
