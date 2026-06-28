FROM almalinux:9

# Clean-machine deps the toolkit relies on (tmux, jq, flock, cksum/timeout, systemd-user).
# coreutils (cksum/timeout) is already provided by coreutils-single in the base.
RUN dnf -y install tmux jq procps-ng sudo \
    && dnf clean all
# The base image masks logind; unmask so lingering + the user manager work
# (the real OL9 host already runs logind with lingering on — this only fixes
# the container so it mirrors that environment).
RUN systemctl unmask systemd-logind.service

# A normal unprivileged user (uid 1000) — NOT /home/opc, to prove portability.
RUN useradd -u 1000 -m agent && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent

COPY stub-claude /usr/local/stub/claude
COPY toolkit /opt/claude-autoresume-src
COPY root-setup.sh /opt/root-setup.sh
COPY agent-test.sh /opt/agent-test.sh
RUN chmod +x /usr/local/stub/claude /opt/root-setup.sh /opt/agent-test.sh \
    /opt/claude-autoresume-src/bin/claude-autoresume \
    /opt/claude-autoresume-src/install.sh /opt/claude-autoresume-src/uninstall.sh

ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/usr/sbin/init"]
