import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Shared by every shadcn/ui component (they import `@/lib/utils`). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
