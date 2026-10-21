import { useEffect, useState } from "react";
import { Home } from "./components/Home";
import { Editor } from "./components/Editor";
import { EditorSession } from "./editorStore";
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
