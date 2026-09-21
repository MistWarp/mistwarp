# MistWarp

The MistWarp projects in one place. Each project keeps its own repository and
its own history; this repo references them as git submodules pinned to a
specific commit, so a single checkout gives you the whole stack at a known-good
combination.

## Getting a checkout

```sh
git clone --recurse-submodules https://github.com/MistWarp/mistwarp.git
cd mistwarp
```

If you already cloned without submodules:

```sh
npm run setup
```

## Layout

| Path | Repository | Branch |
| --- | --- | --- |
| `packages/scratch-audio` | [MistWarp/scratch-audio](https://github.com/MistWarp/scratch-audio) | `develop` |
| `packages/scratch-blocks` | [MistWarp/scratch-blocks](https://github.com/MistWarp/scratch-blocks) | `develop` |
| `packages/scratch-gui` | [MistWarp/scratch-gui](https://github.com/MistWarp/scratch-gui) | `develop` |
| `packages/scratch-paint` | [MistWarp/scratch-paint](https://github.com/MistWarp/scratch-paint) | `develop` |
| `packages/scratch-render` | [MistWarp/scratch-render](https://github.com/MistWarp/scratch-render) | `develop` |
| `packages/scratch-vm` | [MistWarp/scratch-vm](https://github.com/MistWarp/scratch-vm) | `develop` |
| `apps/docs` | [MistWarp/docs](https://github.com/MistWarp/docs) | `master` |
| `apps/desktop` | [MistWarp/desktop](https://github.com/MistWarp/desktop) | `master` |
| `apps/packager` | [MistWarp/packager](https://github.com/MistWarp/packager) | `master` |
| `apps/unpackager` | [MistWarp/unpackager](https://github.com/MistWarp/unpackager) | `main` |
| `services/api` | [MistWarp/api](https://github.com/MistWarp/api) | `main` |
| `services/warptheme` | [MistWarp/warptheme](https://github.com/MistWarp/warptheme) | `main` |

`services/realtime` and `services/status-worker` are not submodules. They had no
repository of their own, so their files live directly in this repo.

## Working on a project

A submodule is a normal checkout, so work inside it as you always have. It
starts on the branch named in `.gitmodules`:

```sh
cd packages/scratch-gui
git checkout develop        # if you are on a detached HEAD
# edit, commit, push to MistWarp/scratch-gui as usual
```

That push updates the project's own repo. To record the new commit here as well:

```sh
cd ../..
git add packages/scratch-gui
git commit -m "Bump scratch-gui"
git push
```

Nothing in this repo is required in order to work on a project — the individual
repositories remain the source of truth.

## Updating the pins

Advance every submodule to the tip of its tracked branch:

```sh
npm run sync
git commit -am "Update submodule pins"
```

Show what each submodule is currently sitting on:

```sh
npm run status
```

## Running things

Each project keeps its own lockfile and package manager (`scratch-gui` uses
pnpm, the rest use npm). The root scripts dispatch to the right one rather than
hoisting anything into a shared workspace:

```sh
npm run install:all            # install dependencies in every JS project
npm run test:all               # run each project's test script
npm run each build scratch-gui # run one task in one project
```

Dependencies are not linked across projects. `scratch-gui` still resolves
`scratch-vm`, `scratch-blocks` and friends from the pinned tarballs in its own
`package.json`, exactly as it does outside this repo.
