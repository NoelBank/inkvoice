# Metrics

Self-owned adoption metrics for Inkvoice.

## `stars.csv`

A daily snapshot of GitHub **stars / forks / watchers**, appended by
[`.github/workflows/star-history.yml`](../.github/workflows/star-history.yml)
(runs ~03:17 UTC daily; also runnable on demand via the Actions tab → "Run
workflow"). Columns: `date,stars,forks,watchers` — `date` is UTC `YYYY-MM-DD`.

The GitHub API only returns the *current* counts, so this file is the durable
history we own.

## Quick chart

Live star history (reconstructed from the stargazer timeline by star-history.com):

<https://star-history.com/#pigontech/inkvoice&Date>

[![Star History Chart](https://api.star-history.com/svg?repos=pigontech/inkvoice&type=Date)](https://star-history.com/#pigontech/inkvoice&Date)

## Docker pulls

Images publish to GHCR (`ghcr.io/pigontech/inkvoice`), which does **not** expose
a public pull-count API, so pull counts aren't tracked here. If images are ever
mirrored to Docker Hub, add its `pull_count` to the snapshot.
