import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon, XIcon } from "lucide-react"

// A toast is one raised slab in the dashboard's flat look: the tone is its icon's colour alone (never a
// tinted fill), the words in full ink, an action (where the thing now lives) as an ink pill, and ✕ to close it.
// Sonner keeps only the stacking, swiping and timing (`unstyled`); everything you see is these classes.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      gap={10}
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-[18px] text-up" />,
        info: <InfoIcon className="size-[18px] text-gold" />,
        warning: <TriangleAlertIcon className="size-[18px] text-warning" />,
        error: <OctagonXIcon className="size-[18px] text-destructive" />,
        loading: <Loader2Icon className="size-[18px] animate-spin text-muted-foreground" />,
        close: <XIcon className="size-4" />,
      }}
      style={{ "--width": "392px" } as React.CSSProperties}
      mobileOffset={{ bottom: "calc(16px + env(safe-area-inset-bottom))", left: "16px", right: "16px" }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group/toast flex w-full items-center gap-3 rounded-[20px] bg-popover py-3 pr-3 pl-4 text-popover-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.45)] dark:shadow-[0_16px_40px_-8px_rgb(0_0_0/0.9)] dark:ring-1 dark:ring-white/[0.06]",
          icon: "flex shrink-0 self-start pt-[3px] [&>svg]:shrink-0",
          content: "flex min-w-0 flex-1 flex-col gap-0.5 py-0.5",
          title: "text-sm leading-snug font-medium text-pretty",
          description: "text-[13px] leading-snug text-muted-foreground text-pretty",
          actionButton:
            "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-full bg-primary px-3.5 text-[13px] font-medium whitespace-nowrap text-primary-foreground transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-gold focus-visible:outline-none",
          cancelButton:
            "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
          // Sonner puts it first in the toast; it closes the row instead
          closeButton:
            "order-last -mr-1 -ml-1 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent! text-muted-foreground! transition-colors hover:bg-muted! hover:text-foreground! focus-visible:ring-2 focus-visible:ring-gold focus-visible:outline-none",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
