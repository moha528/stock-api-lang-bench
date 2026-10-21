# Traitements lourds : Rust contre Java

Conteneur app : 4 vCPU, 512 Mo. Durée par phase : 20s. Conteneur neuf pour chaque traitement.

## hash

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 11.5 | 11.5 | 359.6 | 102.6 | 25.2 | 255.1 | 350 | 11 | non |
| java | 63.0 | 14.3 | 284.5 | 81.4 | 32.8 | 237.4 | 350 | 102 | non |

## montecarlo

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 9.8 | 9.3 | 423.6 | 113.6 | 43.3 | 182.3 | 373 | 11 | non |
| java | 20.6 | 10.7 | 371.1 | 106.3 | 31.9 | 183.5 | 349 | 120 | non |

## reconcile

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 13.4 | 7.8 | 391.0 | 110.8 | 27.3 | 184.2 | 353 | 84 | non |
| java | 24.8 | 8.5 | 338.5 | 96.9 | 31.9 | 221.5 | 349 | 327 | non |

## sort

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 12.6 | 11.4 | 359.4 | 103.6 | 26.9 | 189.8 | 347 | 36 | non |
| java | 60.0 | 35.7 | 108.1 | 30.5 | 83.2 | 630.4 | 355 | 264 | non |

## commissions

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 9.0 | 4.7 | 892.3 | 225.3 | 19.9 | 87.1 | 396 | 231 | non |
| java | 54.4 | 4.9 | 601.5 | 172.4 | 24.2 | 158.1 | 349 | 447 | non |
