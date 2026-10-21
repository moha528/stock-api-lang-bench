#!/bin/sh
# Choisit le GC selon le nombre de CPU que verra la JVM : quota cgroup arrondi au supérieur
# (comme Runtime.availableProcessors()), borné par les CPU de l'hôte.
#   1 CPU  -> SerialGC   : aucun cœur libre pour des threads GC parallèles ou concurrents.
#   >1 CPU -> ParallelGC : collections parallèles sur tous les cœurs, barrière d'écriture aussi
#                          légère que Serial (G1 coûte plus cher sur du code qui déplace des références).
# Chaque GC a son cache AOT, produit au build avec exactement les mêmes options.
set -eu

cpus=$(nproc)
quota=""
if [ -r /sys/fs/cgroup/cpu.max ]; then
  read -r q period < /sys/fs/cgroup/cpu.max
  [ "$q" != "max" ] && quota=$(( (q + period - 1) / period ))
elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then
  q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)
  period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)
  [ "$q" -gt 0 ] && quota=$(( (q + period - 1) / period ))
fi
if [ -n "$quota" ] && [ "$quota" -lt "$cpus" ]; then cpus=$quota; fi
[ "$cpus" -lt 1 ] && cpus=1

if [ "$cpus" -le 1 ]; then
  gc="-XX:+UseSerialGC"; aot=/app/serial.aot
else
  gc="-XX:+UseParallelGC"; aot=/app/parallel.aot
fi
echo "entrypoint: $cpus CPU -> $gc"

exec java @/app/jvm.options $gc -XX:AOTCache=$aot -jar /app/app.jar
