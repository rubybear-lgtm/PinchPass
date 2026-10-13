/** Tool/CLI argument types and translation to pinchpass CLI flags. */
/**
 * Decide how to collect a secret.
 *
 * A tunnel or an explicit `link` request always uses the browser link, since
 * the modal cannot leave the local machine. The modal is only reachable from
 * the interactive TUI; everywhere else (and for `via: "auto"`) the link wins.
 */
export function chooseVia(via, tunnel, mode) {
    const requested = via ?? "auto";
    const forceLink = requested === "link" || tunnel === true;
    const modal = !forceLink && mode === "tui";
    return {
        via: modal ? "modal" : "link",
        downgraded: requested === "modal" && !modal,
    };
}
/** Build the `pinchpass request ...` argv for the given tool arguments. */
export function buildArgs(params) {
    const args = ["request", ...params.names, "-json"];
    if (params.tunnel)
        args.push("-tunnel");
    if (params.note)
        args.push("-note", params.note);
    if (typeof params.ttl === "number")
        args.push("-ttl", String(params.ttl));
    if (params.out)
        args.push("-out", params.out);
    return args;
}
