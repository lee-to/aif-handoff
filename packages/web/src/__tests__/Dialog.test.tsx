import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";

function DialogHarness() {
  const [open, setOpen] = useState(true);

  return (
    <>
      <div data-testid="state">{open ? "open" : "closed"}</div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <div data-testid="dialog-content">Dialog body</div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StackedOverlayHarness() {
  const [sheetOpen, setSheetOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(true);

  return (
    <>
      <div data-testid="sheet-state">{sheetOpen ? "open" : "closed"}</div>
      <div data-testid="dialog-state">{dialogOpen ? "open" : "closed"}</div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent>
          <div>Sheet body</div>
        </SheetContent>
      </Sheet>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <div>Dialog body</div>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("closes on Escape", () => {
    render(<DialogHarness />);

    expect(screen.getByTestId("state").textContent).toBe("open");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("closes on outside click", () => {
    render(<DialogHarness />);

    expect(screen.getByTestId("state").textContent).toBe("open");
    const overlayContainer = document.querySelector(".fixed.inset-0.flex.items-center.justify-center.p-4") as HTMLElement | null;
    expect(overlayContainer).toBeTruthy();
    fireEvent.mouseDown(overlayContainer!);
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("does not close on content click", () => {
    render(<DialogHarness />);

    expect(screen.getByTestId("state").textContent).toBe("open");
    fireEvent.mouseDown(screen.getByTestId("dialog-content"));
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("closes only the top overlay on Escape", () => {
    render(<StackedOverlayHarness />);

    expect(screen.getByTestId("sheet-state").textContent).toBe("open");
    expect(screen.getByTestId("dialog-state").textContent).toBe("open");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("dialog-state").textContent).toBe("closed");
    expect(screen.getByTestId("sheet-state").textContent).toBe("open");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("sheet-state").textContent).toBe("closed");
  });
});
