import { ChevronDown, ChevronRight } from "lucide-react";
import { type CSSProperties, useState } from "react";

interface CollapsibleTextProps {
  text: string;
  threshold?: number;
  style?: CSSProperties;
}

/**
 * Pre-wrapped text with a "Show more / Show less" toggle once the content
 * exceeds `threshold` characters (default 300).
 */
export function CollapsibleText({ text, threshold = 300, style }: CollapsibleTextProps) {
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = text.length > threshold;

  return (
    <div>
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: "0.85rem",
          lineHeight: 1.5,
          ...style,
        }}
      >
        {needsCollapse && !expanded ? text.slice(0, threshold) + "..." : text}
      </div>
      {needsCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginTop: 4,
            fontSize: "0.77rem",
            color: "var(--primary)",
            background: "transparent",
          }}
        >
          {expanded ? (
            <>
              <ChevronDown size={11} /> Show less
            </>
          ) : (
            <>
              <ChevronRight size={11} /> Show more
            </>
          )}
        </button>
      )}
    </div>
  );
}
