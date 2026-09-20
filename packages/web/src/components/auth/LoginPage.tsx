import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { AlertBox } from "@/components/ui/alert-box";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface LoginPageProps {
  onLogin: (input: { username: string; password: string }) => Promise<unknown>;
  isPending: boolean;
  initialError?: string | null;
}

export function LoginPage({ onLogin, isPending, initialError }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setError(null);
    try {
      await onLogin({ username: username.trim(), password });
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Sign in failed");
    } finally {
      setPassword("");
    }
  };

  return (
    <main className="app-pattern-bg flex min-h-screen items-center justify-center p-6 text-foreground">
      <Card className="w-full max-w-md space-y-5 p-6">
        <div className="space-y-2">
          <p className="font-mono text-3xs font-semibold uppercase tracking-[0.2em] text-primary">
            Participant access
          </p>
          <h1 className="font-mono text-xl font-semibold">Sign in to AI Factory</h1>
          <p className="text-sm text-muted-foreground">
            Use your participant credentials to access this workspace.
          </p>
        </div>

        {error && <AlertBox variant="error">{error}</AlertBox>}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Username</span>
            <Input
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              disabled={isPending}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Password</span>
            <Input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={isPending}
            />
          </label>
          <Button
            type="submit"
            className="w-full gap-2"
            disabled={isPending || !username.trim() || !password}
          >
            <LogIn className="h-4 w-4" />
            {isPending ? "Signing in..." : "Sign in"}
          </Button>
        </form>

        <p className="font-mono text-3xs text-muted-foreground">
          Credentials are sent only to the local authentication endpoint and are not included in
          request logs.
        </p>
      </Card>
    </main>
  );
}
