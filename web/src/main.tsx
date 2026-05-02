import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { App } from "./App";
import { PlaylistOrganizer } from "./PlaylistOrganizer";

const basename = (() => {
  const b = import.meta.env.BASE_URL;
  if (!b || b === "/") return undefined;
  return b.endsWith("/") ? b.slice(0, -1) : b;
})();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="/organize/:playlistId" element={<PlaylistOrganizer />} />
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
