import { useEffect, useState } from "react";
import { checkpointService } from "../../services/checkpointService.js";
import { TimelinePanel } from "./TimelinePanel";

interface Props {
  projectDir: string;
}

/**
 * 010 Timeline tab. Hosts the Record / Pause toggles and the Timeline canvas.
 */
export function TimelineView({ projectDir }: Props) {
  const [repoReady, setRepoReady] = useState(true);

  useEffect(() => {
    checkpointService
      .checkIsRepo(projectDir)
      .then(setRepoReady)
      .catch(() => setRepoReady(false));
  }, [projectDir]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          // Inner TimelineGraph wrapper scrolls in both axes; this container
          // just provides the padding around it without competing for scroll.
          display: "flex",
          flexDirection: "column",
          padding: "12px 14px",
          minHeight: 0,
        }}
      >
        <TimelinePanel
          projectDir={projectDir}
          disabled={!repoReady}
          disabledReason={
            !repoReady ? "Initialize version control to enable the timeline." : undefined
          }
        />
      </div>
    </div>
  );
}
