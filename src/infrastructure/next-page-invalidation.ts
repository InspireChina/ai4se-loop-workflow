import { revalidatePath } from 'next/cache';
import { installPageInvalidationAdapter } from './page-invalidation';

export function installNextPageInvalidation() {
  return installPageInvalidationAdapter(revalidatePath);
}
