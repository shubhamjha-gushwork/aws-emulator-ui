# AWS Emulator image, from the official "Getting started with Docker" guide:
# https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html
# EMULATOR_ARCH is aarch64 on Apple silicon / Arm, x86_64 elsewhere (scripts/start-local.sh picks it).
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG EMULATOR_ARCH=x86_64
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-${EMULATOR_ARCH}.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
 && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
