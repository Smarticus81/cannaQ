import { useAuth } from "@clerk/react";
import { Redirect, Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { BrandMark, QualityFlow } from "@/components/BrandMark";
export default function Landing() {
  const { isSignedIn, isLoaded } = useAuth();
  if (isLoaded && isSignedIn) return <Redirect to="/dashboard" />;
  return (
    <div className="cq-landing">
      <header>
        <BrandMark />
        <nav>
          <Link className="cq-text-action" href="/sign-in">
            Sign in
          </Link>
          <Link className="cq-action" href="/sign-up">
            Set up workspace <ArrowRight size={16} />
          </Link>
        </nav>
      </header>
      <main>
        <section>
          <span className="cq-eyebrow">
            QUALITY MANAGEMENT FOR CANNABIS OPERATIONS
          </span>
          <h1>
            Cannabis quality.
            <br />
            From receipt
            <br />
            to release.
          </h1>
          <p className="cq-lead">
            Connect your licensed facilities, controlled documents, production
            records, and quality decisions in one working system.
          </p>
          <Link href="/sign-up" className="cq-action">
            Create your account <ArrowRight size={18} />
          </Link>
          <div className="cq-landing-domains">
            <span>DOCUMENT CONTROL</span>
            <span>PRODUCTION</span>
            <span>TRACEABILITY</span>
            <span>QUALITY EVENTS</span>
          </div>
        </section>
        <QualityFlow />
      </main>
      <footer>
        <span>CANNAQ / CANNABIS QUALITY MANAGEMENT</span>
        <span>Connected records. Accountable actions.</span>
      </footer>
    </div>
  );
}
