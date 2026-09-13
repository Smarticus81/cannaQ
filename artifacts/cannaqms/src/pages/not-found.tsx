import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-lg py-16">
      <p className="cq-eyebrow">Page unavailable</p>
      <h1 className="mt-3 text-3xl font-semibold">We couldn’t find that page.</h1>
      <p className="mt-4 text-muted-foreground">
        The link may be incomplete or the page may have moved. Use the work area
        navigation to find your records, or return to your dashboard.
      </p>
      <Button asChild className="mt-6"><Link href="/dashboard">Back to dashboard</Link></Button>
    </section>
  );
}
