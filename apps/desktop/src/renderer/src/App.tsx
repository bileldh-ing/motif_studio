import { useEffect, useState } from "react";
import { Home } from "./components/Home";
import { Editor } from "./components/Editor";
import { EditorSession } from "./editorStore";
import { installCursors } from "./cursors";

installCursors();
import type { OpenedProject } from "../../shared/api";

export function App() {
  const [session, setSession] = useState<EditorSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = (o: OpenedProject) => {
    window.motif.registerAssets(o.project.assets.map((a) => ({ id: a.id, path: a.path })));
    const s = new EditorSession(o.project, o.path, o.missingAssetIds);
    if (o.recovered) s.toast("Recovered unsaved changes from autosave.", "ok");
    setSession(s);
  };

  useEffect(
    () =>
      window.motif.onMenu(async (cmd) => {
        if (cmd === "diagnostics") {
          const p = await window.motif.diagnostics();
          if (p) alert(`Diagnostic bundle saved to\n${p}\n\nIt contains versions, tool status and logs, never your media or project contents.`);
        }
        if (cmd === "updates") {
          const s = await window.motif.checkForUpdates();
          alert(s.state === "disabled" ? s.reason : s.state === "none" ? "MOTIF is up to date." : s.state === "error" ? `Update check failed: ${s.message}` : s.state === "ready" ? `Version ${s.version} is ready. Restart to install.` : "Checking for updates…");
        }
      }),
    [],
  );

  useEffect(() => {
    const onErr = (e: ErrorEvent) => setError(e.message);
    window.addEventListener("error", onErr);
    return () => window.removeEventListener("error", onErr);
  }, []);

  return (
    <>
      {session ? <Editor key={session.path} session={session} onClose={() => setSession(null)} /> : <Home onOpen={open} />}
      {error && (
        <div className="fatal" role="alert">
          <strong>Something went wrong.</strong> {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </>
  );
}
