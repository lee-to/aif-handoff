import { useState } from "react";
import { cn } from "@/lib/utils";

interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void;
  renderView: (props: { value: string; onEdit: () => void }) => React.ReactNode;
  renderEdit: (props: {
    draft: string;
    onChange: (v: string) => void;
    onSave: () => void;
    onCancel: () => void;
  }) => React.ReactNode;
  className?: string;
}

function InlineEditor({ value, onSave, renderView, renderEdit, className }: InlineEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const handleSave = () => {
    onSave(draft);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setDraft(value);
    setIsEditing(false);
  };

  const handleEdit = () => {
    setDraft(value);
    setIsEditing(true);
  };

  return (
    <div className={cn(className)}>
      {isEditing
        ? renderEdit({
            draft,
            onChange: setDraft,
            onSave: handleSave,
            onCancel: handleCancel,
          })
        : renderView({ value, onEdit: handleEdit })}
    </div>
  );
}

export { InlineEditor };
