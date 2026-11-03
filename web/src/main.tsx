import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";

const root = createRoot(document.getElementById("root")!);

async function mountPage() {
  if (/^\/app\/?$/.test(window.location.pathname)) {
    const [{ App }] = await Promise.all([
      import("./App"),
      import("./styles.css"),
    ]);
    document.title = "Morning · Assistant";
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    return;
  }

  const { LandingPage } = await import("./landing/LandingPage");
  root.render(
    <StrictMode>
      <LandingPage guestHref="/app" />
    </StrictMode>,
  );
}

void mountPage();
