#!/bin/zsh
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL
umask 077

fail() {
    print -u2 -- "Install error: $*"
    exit 1
}

[[ "$OSTYPE" == darwin* ]] || fail "This package is for macOS."
(( EUID != 0 )) || fail "Run as your normal user, without sudo."
[[ -d /Applications/Claude.app ]] || fail "Install Claude Desktop at /Applications/Claude.app first."
command -v node >/dev/null 2>&1 || fail "Install Node.js 22 or newer and put node on PATH."
command node -e '
    if (Number(process.versions.node.split(".")[0]) < 22) {
        console.error("Node.js 22 or newer is required.");
        process.exit(1);
    }
' || fail "Unsupported Node.js version."

source_dir="${0:A:h}"
target_dir="$HOME/.local/bin"
files=(claude-3p-context.cjs ccd.zsh)

for name in "${files[@]}"; do
    [[ -f "$source_dir/$name" && ! -L "$source_dir/$name" ]] ||
        fail "Missing or symlinked source file: $source_dir/$name"
done
command node --check "$source_dir/claude-3p-context.cjs"
/bin/zsh -n "$source_dir/ccd.zsh"

[[ ! -L "$HOME/.local" && ! -L "$target_dir" ]] ||
    fail "Refusing a symlinked ~/.local or ~/.local/bin directory."
/bin/mkdir -p "$target_dir"
for name in "${files[@]}"; do
    destination="$target_dir/$name"
    [[ ! -L "$destination" ]] || fail "Refusing symlink: $destination"
    if [[ -e "$destination" && ! -f "$destination" ]]; then
        fail "Not a regular file: $destination"
    fi
done

if [[ -f "$target_dir/claude-3p-context.cjs" ]]; then
    helper_status="$(command node "$target_dir/claude-3p-context.cjs" status)" ||
        fail "Could not read the installed helper's status. No scripts were replaced."
    [[ "$helper_status" != Running:* ]] ||
        fail "The helper is running. Run ccd stop, then run this installer again."
fi

for name in "${files[@]}"; do
    source_file="$source_dir/$name"
    destination="$target_dir/$name"
    if [[ -f "$destination" ]]; then
        if /usr/bin/cmp -s "$source_file" "$destination"; then
            print -r -- "Already installed: $destination"
            continue
        fi
        backup="$(/usr/bin/mktemp "$destination.backup.XXXXXX")"
        /bin/cp -p "$destination" "$backup"
        print -r -- "Saved previous file: $backup"
    fi
    /usr/bin/install -m 600 "$source_file" "$destination"
    print -r -- "Installed: $destination"
done

print
print -r -- 'Add this line to your ~/.zshrc, replacing any old ccd alias/function:'
print -r -- 'source "$HOME/.local/bin/ccd.zsh"'
print
print -r -- 'Then run: source ~/.zshrc'
print -r -- 'Launch with: ccd'
print -r -- 'The installer did not edit shell, Claude, or Ollama settings and did not start a watcher.'
