# Source this file from ~/.zshrc; it defines ccd without launching anything.
if (( ${+aliases[ccd]} )); then
    unalias ccd
fi

function ccd {
    if ! command -v node >/dev/null 2>&1; then
        print -u2 -- "ccd: Node.js is not on PATH. Install Node.js 22 or newer and reopen your terminal."
        return 127
    fi
    command node "$HOME/.local/bin/claude-3p-context.cjs" "$@"
}
