# syntax=docker/dockerfile:1
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
FROM ${DEBIAN_IMAGE} AS build
RUN --mount=type=secret,id=proxy_ca \
    bundle=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then bundle=/run/secrets/proxy_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$bundle" update && \
    apt-get -o Acquire::https::CaInfo="$bundle" install -y \
      --no-install-recommends ca-certificates cmake g++ make git perl && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY CMakeLists.txt CMakePresets.json ./
COPY cmake/ ./cmake/
COPY include/ ./include/
COPY src/ ./src/
RUN --mount=type=secret,id=proxy_ca \
    bundle=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then bundle=/run/secrets/proxy_ca; fi; \
    GIT_SSL_CAINFO="$bundle" cmake --preset release && \
    cmake --build --preset release --parallel 4

FROM ${DEBIAN_IMAGE} AS production
RUN --mount=type=secret,id=proxy_ca \
    bundle=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then bundle=/run/secrets/proxy_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$bundle" update && \
    apt-get -o Acquire::https::CaInfo="$bundle" install -y \
      --no-install-recommends libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /var/lib/cot-to-vmf && chown 10001:10001 /var/lib/cot-to-vmf
COPY --from=build /source/build/release/src/cot-to-vmf /usr/local/bin/
COPY --from=build /source/build/release/licenses/ /usr/local/share/cot-to-vmf/licenses/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh
ENV COT_VMF_WORKSPACE=/var/lib/cot-to-vmf
USER 10001:10001
WORKDIR /var/lib/cot-to-vmf
EXPOSE 9001/udp 8080/tcp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["run"]
