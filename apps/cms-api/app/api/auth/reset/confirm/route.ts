import { handleTokenPassword } from '@/lib/token-password.ts';

export function POST(request: Request) {
  return handleTokenPassword(request, 'reset');
}
