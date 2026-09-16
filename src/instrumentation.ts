export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installNextPageInvalidation } = await import('./infrastructure/next-page-invalidation');
    installNextPageInvalidation();
    // Initialize supervision on service startup, not on the first settings
    // request. Business startup errors are captured by independent management.
    const { webLoopRunLifecycle } = await import('./application/loop-run-lifecycle');
    await webLoopRunLifecycle();
  }
}
