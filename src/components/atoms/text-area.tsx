import { Textarea as ShadcnTextarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function TextArea({
  className,
  ...props
}: React.ComponentProps<typeof ShadcnTextarea>) {
  return (
    <ShadcnTextarea
      className={cn("rounded-md min-h-24 px-3 py-2 text-sm", className)}
      {...props}
    />
  );
}
