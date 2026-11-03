import { useEffect, useRef } from "react";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mountPageVapour } from "./vapour/page-vapour.js";
import "./landing.css";

export function LandingPage({ guestHref }: { guestHref: string }) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!pageRef.current || !canvasRef.current) return;
    return mountPageVapour(pageRef.current, canvasRef.current);
  }, []);

  return (
    <div className="morning-landing" ref={pageRef}>
      <canvas
        ref={canvasRef}
        className="landing-vapour"
        aria-hidden="true"
        hidden
      />
      <header className="landing-header">
        <span className="landing-wordmark" data-vapour-text>
          Morning
        </span>
        <nav className="landing-links" aria-label="Project links">
          <a href="https://github.com/0atxl/morning">GitHub</a>
          <Button asChild variant="secondary" className="landing-presentation">
            <a
              href="/presentation.html"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Presentation (opens in a new tab)"
            >
              Presentation
              <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
        </nav>
      </header>

      <main className="landing-main" aria-labelledby="landing-title">
        <div className="landing-intro">
          <h1 id="landing-title" data-vapour-text>
            A little less
            <br />
            to remember.
          </h1>
          <p className="landing-description" data-vapour-text>
            Speak naturally and turn your words into reminders and email drafts
            you can edit.
          </p>
          <div className="landing-actions">
            <Button asChild size="lg" className="landing-cta">
              <a href={guestHref}>
                Try Morning
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
            <p className="landing-guest-note">No account needed.</p>
          </div>
        </div>

        <figure
          className="landing-example"
          aria-label="Example voice request and reminder"
        >
          <div className="landing-orb" aria-hidden="true" />
          <blockquote className="landing-utterance">
            <p data-vapour-text>
              "Remind me Friday at ten to follow up with Priya"
            </p>
          </blockquote>
          <div className="landing-result" data-ui>
            <Check className="landing-result-check" aria-hidden="true" />
            <p>
              <span className="landing-result-title" data-vapour-text>
                Follow up with Priya
              </span>
              <span className="landing-result-separator" aria-hidden="true">
                {" "}
                ·{" "}
              </span>
              <span className="landing-result-time" data-vapour-text>
                Friday, 10:00 AM
              </span>
            </p>
          </div>
          <figcaption className="landing-example-caption">
            An example reminder
          </figcaption>
        </figure>
      </main>
    </div>
  );
}
