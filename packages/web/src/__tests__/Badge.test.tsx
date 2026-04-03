import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge, badgeVariants } from "@/components/ui/badge";

describe("Badge", () => {
  describe("existing variants", () => {
    it("renders default variant", () => {
      render(<Badge>Default</Badge>);
      const badge = screen.getByText("Default");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("bg-primary/15");
    });

    it("renders secondary variant", () => {
      render(<Badge variant="secondary">Secondary</Badge>);
      const badge = screen.getByText("Secondary");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("bg-secondary");
    });

    it("renders destructive variant", () => {
      render(<Badge variant="destructive">Destructive</Badge>);
      const badge = screen.getByText("Destructive");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("bg-destructive/15");
    });

    it("renders outline variant", () => {
      render(<Badge variant="outline">Outline</Badge>);
      const badge = screen.getByText("Outline");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("text-foreground");
    });
  });

  describe("priority variants", () => {
    it.each(["low", "medium", "high", "urgent"] as const)(
      "renders priority-%s variant",
      (level) => {
        const variant = `priority-${level}` as const;
        render(<Badge variant={variant}>{level}</Badge>);
        const badge = screen.getByText(level);
        expect(badge).toBeInTheDocument();
        expect(badge.className).toContain(`text-priority-${level}`);
        expect(badge.className).toContain(`bg-priority-${level}/15`);
        expect(badge.className).toContain(`border-priority-${level}/30`);
      },
    );
  });

  describe("semantic variants", () => {
    it("renders tool variant", () => {
      render(<Badge variant="tool">Tool</Badge>);
      const badge = screen.getByText("Tool");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("bg-cyan-500/10");
      expect(badge.className).toContain("border-cyan-500/30");
    });

    it("renders agent variant", () => {
      render(<Badge variant="agent">Agent</Badge>);
      const badge = screen.getByText("Agent");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("bg-violet-500/10");
      expect(badge.className).toContain("border-violet-500/30");
    });

    it("renders error variant", () => {
      render(<Badge variant="error">Error</Badge>);
      const badge = screen.getByText("Error");
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain("bg-destructive/15");
      expect(badge.className).toContain("border-destructive/30");
    });
  });

  describe("custom className", () => {
    it("merges custom className with variant classes", () => {
      render(<Badge className="mt-4">Styled</Badge>);
      const badge = screen.getByText("Styled");
      expect(badge.className).toContain("mt-4");
      expect(badge.className).toContain("bg-primary/15");
    });
  });

  describe("children", () => {
    it("renders string children", () => {
      render(<Badge>Hello</Badge>);
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });

    it("renders element children", () => {
      render(
        <Badge>
          <span data-testid="inner">Nested</span>
        </Badge>,
      );
      expect(screen.getByTestId("inner")).toBeInTheDocument();
      expect(screen.getByTestId("inner").textContent).toBe("Nested");
    });
  });

  describe("accessibility", () => {
    it("renders as a div element", () => {
      render(<Badge data-testid="badge">Content</Badge>);
      const badge = screen.getByTestId("badge");
      expect(badge.tagName).toBe("DIV");
    });

    it("forwards aria attributes", () => {
      render(
        <Badge aria-label="status badge" role="status">
          Active
        </Badge>,
      );
      const badge = screen.getByRole("status");
      expect(badge).toHaveAttribute("aria-label", "status badge");
    });
  });

  describe("badgeVariants", () => {
    it("exports badgeVariants for external use", () => {
      expect(badgeVariants).toBeDefined();
      expect(typeof badgeVariants).toBe("function");
    });

    it("generates class string for each variant", () => {
      const variants = [
        "default",
        "secondary",
        "destructive",
        "outline",
        "priority-low",
        "priority-medium",
        "priority-high",
        "priority-urgent",
        "tool",
        "agent",
        "error",
      ] as const;

      for (const variant of variants) {
        const classes = badgeVariants({ variant });
        expect(classes).toBeTruthy();
        expect(typeof classes).toBe("string");
      }
    });
  });
});
