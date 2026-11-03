import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import { LandingPage } from "./LandingPage";

// A separate entry keeps the first draft available without the shared bootstrap.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LandingPage guestHref="/app" />
  </StrictMode>,
);
