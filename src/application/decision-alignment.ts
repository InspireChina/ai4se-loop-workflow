import { deliverySpecSchema } from '../domain/agent-result';
import type { DeliverySpecRecord, Question } from './tasks';

export function decisionAnswerText(answer: string, consequences: string[]) {
  if (!consequences.length) return answer;
  const trimmed = answer.trim();
  const separator = /[。！？；：]$/.test(trimmed) ? '' : /[.!?;:]$/.test(trimmed) ? ' ' : '。';
  return `${answer}${separator}${consequences.join('；')}`;
}

function parseDeliverySpec(record: DeliverySpecRecord) {
  try {
    const parsed = deliverySpecSchema.safeParse(JSON.parse(record.spec_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function currentDeliverySpecs(records: DeliverySpecRecord[]) {
  const current = new Map<number, DeliverySpecRecord>();
  for (const record of records) {
    if (record.status === 'superseded') continue;
    const previous = current.get(record.story_index);
    if (!previous || record.revision > previous.revision) current.set(record.story_index, record);
  }
  return [...current.values()];
}

/**
 * Builds the read-only task decision view without publishing resolved delivery
 * decisions as clarification questions or feeding them back into Agent context.
 */
export function decisionAlignmentQuestions(
  questions: Question[],
  deliverySpecs: DeliverySpecRecord[],
) {
  const projected = [...questions];
  const published = new Set(questions
    .filter((question) => question.decision_key)
    .map((question) => `${question.story_index ?? 'task'}:${question.decision_key}`));

  for (const record of currentDeliverySpecs(deliverySpecs)) {
    const spec = parseDeliverySpec(record);
    if (!spec) continue;

    for (const decision of spec.decisions) {
      const identity = `${record.story_index}:${decision.key}`;
      if (published.has(identity)) continue;

      const selectedOptionId = decision.status === 'resolved'
        ? decision.selectedOption || null
        : decision.recommendationOption;
      const selectedOption = decision.options.find((option) => option.id === selectedOptionId);
      const resolved = decision.status === 'resolved';
      projected.push({
        question_id: `SPEC-${record.spec_id}-${decision.key}`,
        task_id: record.task_id,
        story_index: record.story_index,
        title: decision.title,
        question: decision.question,
        why: decision.impact,
        recommendation: selectedOption?.label || null,
        answer: resolved ? decision.decision : null,
        status: resolved ? 'resolved' : 'pending',
        relative_path: null,
        source_agent: 'analyst-agent',
        kind: 'analysis',
        decision_key: decision.key,
        alternatives_json: decision.options.length ? JSON.stringify(decision.options) : null,
        recommendation_reason: resolved ? decision.rationale : decision.recommendationReason,
        depends_on_json: null,
        activation_json: null,
        selected_option_id: selectedOptionId,
        status_reason: null,
        decision_authority: resolved && decision.authority !== 'user' ? 'agent' : 'human',
        spec_revision: record.revision,
        resolved_at: resolved ? record.resolved_at : null,
        created_at: record.created_at,
        updated_at: record.resolved_at || record.created_at,
      });
      published.add(identity);
    }
  }

  return projected;
}
