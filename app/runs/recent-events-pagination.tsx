'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { FormEvent } from 'react';

type RecentEventsPaginationProps = {
  currentPage: number;
  pageSize: number;
  totalPages: number;
};

function pageHref(page: number, pageSize: number) {
  const parameters = new URLSearchParams();
  if (page > 1) parameters.set('page', String(page));
  if (pageSize !== 10) parameters.set('pageSize', String(pageSize));
  const query = parameters.toString();
  return `${query ? `/runs?${query}` : '/runs'}#recent-events`;
}

function visiblePages(currentPage: number, totalPages: number) {
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  return [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
}

export function RecentEventsPagination({ currentPage, pageSize, totalPages }: RecentEventsPaginationProps) {
  const router = useRouter();
  const pages = visiblePages(currentPage, totalPages);
  const applyPageSize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selectedPageSize = Number(new FormData(event.currentTarget).get('pageSize'));
    router.push(pageHref(1, selectedPageSize));
  };

  return <nav className="pagination" aria-label="最近事件分页">
    <form className="pagination-size" onSubmit={applyPageSize}>
      <label>每页
        <select name="pageSize" defaultValue={pageSize} aria-label="每页展示条数">
          {[10, 20, 50, 100].map((size) => <option value={size} key={size}>{size} 条</option>)}
        </select>
      </label>
      <button className="pagination-apply" type="submit">应用</button>
    </form>
    {totalPages > 1 && <>
    {currentPage > 1
      ? <Link className="pagination-direction" href={pageHref(currentPage - 1, pageSize)} aria-label="上一页"><ChevronLeft size={15}/>上一页</Link>
      : <span className="pagination-direction" aria-disabled="true"><ChevronLeft size={15}/>上一页</span>}
    <div className="pagination-pages">
      {pages.map((page, index) => <span className="pagination-page-item" key={page}>
        {index > 0 && page - pages[index - 1] > 1 && <span className="pagination-ellipsis" aria-hidden="true">…</span>}
        <Link href={pageHref(page, pageSize)} aria-current={page === currentPage ? 'page' : undefined} aria-label={`第 ${page} 页`}>{page}</Link>
      </span>)}
    </div>
    {currentPage < totalPages
      ? <Link className="pagination-direction" href={pageHref(currentPage + 1, pageSize)} aria-label="下一页">下一页<ChevronRight size={15}/></Link>
      : <span className="pagination-direction" aria-disabled="true">下一页<ChevronRight size={15}/></span>}
    </>}
  </nav>;
}
