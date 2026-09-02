export type AgentCommandValidationIssue = {
  code: string;
  path: string;
  message: string;
  expected?: string;
  received?: string;
};

export type AgentCommandRejection = {
  code: string;
  path?: string;
  message: string;
  issues: AgentCommandValidationIssue[];
  occurrence: number;
  refreshCommand?: string;
  schemaCommand?: string;
  templateCommand?: string;
};

export class AgentCommandValidationError extends Error {
  readonly issues: AgentCommandValidationIssue[];
  readonly schemaCommand?: string;
  readonly templateCommand?: string;

  constructor(
    message: string,
    issues: AgentCommandValidationIssue[],
    options: { schemaCommand?: string; templateCommand?: string } = {},
  ) {
    super(message);
    this.name = 'AgentCommandValidationError';
    this.issues = issues;
    this.schemaCommand = options.schemaCommand;
    this.templateCommand = options.templateCommand;
  }
}

export class AgentCommandRejectedError extends Error {
  readonly commandRejection: AgentCommandRejection;

  constructor(rejection: AgentCommandRejection) {
    super(rejection.message);
    this.name = 'AgentCommandRejectedError';
    this.commandRejection = rejection;
  }
}

function inferredCode(message: string) {
  if (/不是有效 YAML/.test(message)) return 'invalid_yaml';
  if (/包含未声明字段/.test(message)) return 'schema_undeclared_fields';
  if (/必填|不能为空/.test(message)) return 'schema_required';
  if (/必须是/.test(message)) return 'schema_type_or_enum';
  if (/建议决定权无效|决策权限无效/.test(message)) return 'decision_authority_invalid';
  if (/不属于当前.+工作包|不允许命令|只允许 YAML 命令链协议/.test(message)) return 'command_not_allowed';
  if (/必须读取 \$LOOP_AGENT_TMP_DIR/.test(message)) return 'temporary_file_outside_execution';
  if (/缺少文件路径|必须提供值/.test(message)) return 'command_argument_missing';
  return 'command_rejected';
}

function inferredPath(message: string) {
  const match = message.match(/(?:^|\n- )([a-z0-9][a-z0-9._:/\-\[\]]+)(?::|\s(?:必填|必须|包含))/i);
  return match?.[1];
}

export function rejectionFromError(error: unknown, occurrence = 1): AgentCommandRejection {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AgentCommandRejectedError) {
    return { ...error.commandRejection, occurrence: error.commandRejection.occurrence || occurrence };
  }
  if (error instanceof AgentCommandValidationError) {
    return {
      code: error.issues[0]?.code || 'schema_validation_failed',
      path: error.issues[0]?.path,
      message,
      issues: error.issues,
      occurrence,
      schemaCommand: error.schemaCommand,
      templateCommand: error.templateCommand,
    };
  }
  return {
    code: inferredCode(message),
    path: inferredPath(message),
    message,
    issues: [],
    occurrence,
  };
}

export function isAgentCommandRejectedError(error: unknown): error is AgentCommandRejectedError {
  return Boolean(error && typeof error === 'object' && 'commandRejection' in error);
}

export function renderAgentCommandRejection(command: string, rejection: AgentCommandRejection) {
  const repeated = rejection.occurrence >= 2;
  const issueLines = rejection.issues.length
    ? rejection.issues.flatMap((issue) => [
        `- [${issue.code}] ${issue.path}: ${issue.message}`,
        ...(issue.expected ? [`  - Expected: ${issue.expected}`] : []),
        ...(issue.received ? [`  - Received: ${issue.received}`] : []),
      ])
    : rejection.message.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => `- ${line.replace(/^[-*]\s*/, '')}`);
  return [
    '# COMMAND RESULT', '',
    `- Command: \`${command || '(empty)'}\``,
    '- Outcome: rejected',
    `- Error-Code: ${rejection.code}`,
    ...(rejection.path ? [`- Error-Path: ${rejection.path}`] : []),
    `- Occurrence: ${rejection.occurrence}`,
    '', '# NEXT', '',
    `- Action: ${repeated ? 'refresh_schema_and_retry' : 'correct_and_retry'}`,
    `- Refresh: \`${rejection.refreshCommand || 'status'}\``,
    ...(rejection.schemaCommand ? [`- Schema: \`${rejection.schemaCommand}\``] : []),
    ...(rejection.templateCommand ? [`- Template: \`${rejection.templateCommand}\``] : []),
    ...(repeated ? ['- Guard: 同一错误已重复出现；不要继续猜测字段，先读取 Schema 或模板后再提交。'] : []),
    '', '# VALIDATION ERRORS', '',
    ...issueLines,
    '',
  ].join('\n');
}
