import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex h-8 items-center justify-center gap-2 border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-zinc-900 bg-zinc-900 px-3 text-white hover:bg-zinc-700",
        outline: "border-zinc-300 bg-white px-3 text-zinc-700 hover:border-zinc-500 hover:bg-zinc-50",
        ghost: "border-transparent bg-transparent px-2 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950",
        icon: "size-8 border-zinc-300 bg-white p-0 text-zinc-600 hover:border-zinc-500 hover:text-zinc-950"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}
