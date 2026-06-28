# Clean-machine verification

Proves the toolkit has no host-specific assumptions by installing and running it
in a fresh AlmaLinux 9 container (closest match to the OL9 target), as a generic
`uid 1000` user, with a stub `claude` (no auth/network). It exercises both the
direct launcher path and the **real systemd-user unit**.

```sh
docker build -t claude-autoresume-verify .
docker run -d --name car-verify --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /tmp claude-autoresume-verify
# wait for `systemctl is-system-running` to report running/degraded, then:
docker exec car-verify /opt/root-setup.sh
docker exec -u agent car-verify bash /opt/agent-test.sh   # expect: OVERALL: PASS
docker rm -f car-verify
```

`agent-test.sh` asserts: `doctor: PASS`, direct launch (`enabled=1 launched=1
live=1`, no false `[!!]`), pane actually resumed, idempotent re-run skip, clean
stop, `systemd-analyze --user verify` of the unit, the unit starting
`active(exited)` with `Result=success`, the **tmux session surviving the oneshot
ExecStart completing** (the load-bearing boot claim), and a clean `ExecStop`
teardown.

Files: `Dockerfile`, `stub-claude` (fake CLI), `root-setup.sh` (provision the
agent HOME + lingering), `agent-test.sh` (the assertions). The base image masks
`systemd-logind`; the Dockerfile unmasks it so the container mirrors a normal
host (the real OL9 target already runs logind with lingering enabled).
