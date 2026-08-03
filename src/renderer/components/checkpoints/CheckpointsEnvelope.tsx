import { useCallback, useEffect, useState } from "react";
import { checkpointService } from "../../services/checkpointService.js";
import { IdentityPrompt } from "./IdentityPrompt";
import { InitRepoPrompt } from "./InitRepoPrompt";

interface Props {
  projectDir: string | null;
}

/**
 * Top-level envelope that owns the InitRepo + Identity prompt flow on
 * project-open. Mounts inside AppShell after a project is open.
 */
export function CheckpointsEnvelope({ projectDir }: Props) {
  const [needsRepoInit, setNeedsRepoInit] = useState(false);
  const [needsIdentity, setNeedsIdentity] = useState<null | {
    name: string | null;
    email: string | null;
    suggestedName: string;
    suggestedEmail: string;
  }>(null);

  // Project-open checks: repo exists + identity set
  useEffect(() => {
    if (!projectDir) return;
    (async () => {
      const isRepo = await checkpointService.checkIsRepo(projectDir);
      if (!isRepo) {
        setNeedsRepoInit(true);
        return;
      }
      const id = await checkpointService.checkIdentity(projectDir);
      if (!id.name || !id.email) {
        setNeedsIdentity(id);
      }
    })();
  }, [projectDir]);

  const handleInitRepo = useCallback(async () => {
    if (!projectDir) return;
    const r = await checkpointService.initRepo(projectDir);
    if (r.ok) {
      setNeedsRepoInit(false);
      const id = await checkpointService.checkIdentity(projectDir);
      if (!id.name || !id.email) setNeedsIdentity(id);
    }
  }, [projectDir]);

  const handleSaveIdentity = useCallback(
    async (name: string, email: string) => {
      if (!projectDir) return;
      await checkpointService.setIdentity(projectDir, name, email);
      setNeedsIdentity(null);
    },
    [projectDir],
  );

  return (
    <>
      {needsRepoInit && projectDir && (
        <InitRepoPrompt
          projectDir={projectDir}
          onSkip={() => setNeedsRepoInit(false)}
          onInit={handleInitRepo}
        />
      )}
      {needsIdentity && (
        <IdentityPrompt
          suggestedName={needsIdentity.suggestedName}
          suggestedEmail={needsIdentity.suggestedEmail}
          initialName={needsIdentity.name}
          initialEmail={needsIdentity.email}
          onSkip={() => setNeedsIdentity(null)}
          onSave={handleSaveIdentity}
        />
      )}
    </>
  );
}
