# Traitements lourds : Rust contre Java

Conteneur app : 1 vCPU, 512 Mo. Durée par phase : 20s. Conteneur neuf pour chaque traitement.

## hash

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 11.7 | 11.4 | 88.8 | 95.3 | 25.1 | 769.4 | 93 | 10 | non |
| java | 143.4 | 22.8 | 63.3 | 67.8 | 61.3 | 1762.1 | 93 | 65 | non |

## montecarlo

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 10.0 | 9.4 | 93.8 | 98.6 | 46.7 | 1068.0 | 95 | 11 | non |
| java | 21.3 | 10.8 | 73.6 | 83.5 | 57.9 | 2401.2 | 88 | 83 | non |

## reconcile

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 17.3 | 8.3 | 125.0 | 134.5 | 24.3 | 535.0 | 93 | 25 | non |
| java | 370.1 | 10.2 | 97.9 | 107.7 | 34.8 | 1469.7 | 91 | 214 | non |

## sort

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 13.3 | 11.3 | 89.3 | 95.9 | 26.7 | 739.7 | 93 | 17 | non |
| java | 86.4 | 39.7 | 26.9 | 28.6 | 95.4 | 2549.8 | 94 | 213 | non |

## commissions

| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| rust | 195.8 | 4.7 | 223.6 | 243.4 | 25.7 | 528.5 | 92 | 166 | non |
| java | 97.9 | 4.9 | 210.4 | 229.8 | 40.0 | 711.3 | 92 | 375 | non |
