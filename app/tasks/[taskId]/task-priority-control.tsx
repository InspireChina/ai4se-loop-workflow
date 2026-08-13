'use client';

import { LoaderCircle } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_REQUIREMENT_PRIORITY,
  normalizedRequirementPriority,
  REQUIREMENT_PRIORITY_OPTIONS,
  type RequirementPriority,
} from '../../../src/domain/requirement-priority';
import { updateTaskPriorityAction } from '../../actions';

export function TaskPriorityControl({ taskId, priority }: { taskId: string; priority: string | null }) {
  const router = useRouter();
  const normalized = normalizedRequirementPriority(priority) || DEFAULT_REQUIREMENT_PRIORITY;
  const [selected, setSelected] = useState<RequirementPriority>(normalized);
  const [isPending, startTransition] = useTransition();

  useEffect(() => setSelected(normalized), [normalized]);

  return <span className="task-priority-control" title="数字越大越优先派发，9 为最高优先级">
    <span>优先级 ·</span>
    <select aria-label="需求优先级，9 为最高" value={selected} disabled={isPending} onChange={(event) => {
      const next = event.target.value as RequirementPriority;
      const previous = selected;
      setSelected(next);
      startTransition(async () => {
        try {
          await updateTaskPriorityAction(taskId, next);
          router.refresh();
        } catch {
          setSelected(previous);
        }
      });
    }}>
      {REQUIREMENT_PRIORITY_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>
    {isPending && <LoaderCircle className="spin" size={12} aria-hidden="true"/>}
  </span>;
}
