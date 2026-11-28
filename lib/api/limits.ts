/**
 * Ceilings for bulk callers (#39). The job runner (#40) enforces these when it
 * accepts a job; they live here so the API docs and the runner share one number.
 */
export const MAX_PAGES_PER_JOB = 500;
export const MAX_CONCURRENT_JOBS_PER_CREDENTIAL = 2;
