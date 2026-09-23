import { ApiResponseError } from '@/api';

export function deployErrorFor(error: unknown): string {
  if (error instanceof ApiResponseError && error.code === 'deploy.already_running') {
    return 'A deployment is already running for this project. Wait for it to finish before starting another.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Could not start the deploy. Please try again.';
}
