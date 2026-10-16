/** 类名拼接（clsx；Octo Work 已是纯 CSS/SCSS，没有 Tailwind）。从 @/lib/utils 归位。 */
import { clsx, type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

export type { ClassValue }
