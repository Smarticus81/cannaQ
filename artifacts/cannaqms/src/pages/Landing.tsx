import { useAuth } from "@clerk/react";
import { Redirect, Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Landing() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return null;
  if (isSignedIn) return <Redirect to="/dashboard" />;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="px-6 h-16 flex items-center border-b justify-between">
        <img src="/logo.svg" alt="CannaQ" className="h-8" />
        <div className="space-x-4">
          <Link href="/sign-in" className="text-sm font-medium hover:underline">Sign In</Link>
          <Link href="/sign-up">
            <Button size="sm">Get Started</Button>
          </Link>
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center text-center px-4">
        <h1 className="text-5xl font-extrabold tracking-tight max-w-3xl mb-6">
          The Electronic Quality Management System for Cannabis Processors
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mb-10">
          Built for compliance. Engineered for speed. CannaQ is the source of truth for regulated activities in Michigan processing facilities.
        </p>
        <div className="flex space-x-4">
          <Link href="/sign-up">
            <Button size="lg" className="h-12 px-8 text-lg">Start Free Trial</Button>
          </Link>
        </div>
      </main>
    </div>
  );
}