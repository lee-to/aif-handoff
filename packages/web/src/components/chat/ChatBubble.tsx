import { createPortal } from "react-dom";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatBubbleProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function ChatBubble({ isOpen, onToggle }: ChatBubbleProps) {
  if (isOpen) return null;

  return createPortal(
    <Button
      onClick={onToggle}
      size="icon"
      className={cn(
        "fixed bottom-6 left-6 h-14 w-14 rounded-full",
        "transition-transform duration-300 ease-in-out hover:scale-105",
      )}
      style={{ zIndex: "var(--z-bubble)" }}
      aria-label="Open chat"
    >
      <Bot className="h-6 w-6" />
    </Button>,
    document.body,
  );
}
