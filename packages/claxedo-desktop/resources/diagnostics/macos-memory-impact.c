#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc < 2 || argc > 513) return 2;

  for (int index = 1; index < argc; index++) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(argv[index], &end, 10);
    if (errno != 0 || end == argv[index] || *end != '\0' || parsed <= 0 || parsed > INT_MAX) continue;

    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage((int)parsed, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) continue;
    printf("%ld %llu\n", parsed, usage.ri_phys_footprint);
  }
  return 0;
}
