/** Tool/CLI argument types and translation to pinchpass CLI flags. */

export interface RequestArgs {
  names: string[];
  tunnel?: boolean;
  note?: string;
  ttl?: number;
  out?: string;
  via?: "auto" | "modal" | "link";
}

export type CollectionVia = "modal" | "link";

/**
 * Decide how to collect a secret.
 *
 * A tunnel or an explicit `link` request always uses the browser link, since
 * the modal cannot leave the local machine. The modal is only reachable from
 * the interactive TUI; everywhere else (and for `via: "auto"`) the link wins.
 */
export function chooseVia(
  via: RequestArgs["via"],
  tunnel: boolean | undefined,
  mode: string,
): { via: CollectionVia; downgraded: boolean } {
  const requested = via ?? "auto";
  const forceLink = requested === "link" || tunnel === true;
  const modal = !forceLink && mode === "tui";
  return {
    via: modal ? "modal" : "link",
    downgraded: requested === "modal" && !modal,
  };
}

/** Build the `pinchpass request ...` argv for the given tool arguments. */
export function buildArgs(params: RequestArgs): string[] {
  const args = ["request", ...params.names, "-json"];
  if (params.tunnel) args.push("-tunnel");
  if (params.note) args.push("-note", params.note);
  if (typeof params.ttl === "number") args.push("-ttl", String(params.ttl));
  if (params.out) args.push("-out", params.out);
  return args;
}
