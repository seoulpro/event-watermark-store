# License notes

The package source is distributed under the ISC license in the repository root.
The published package has no runtime dependencies.

ioredis and node-redis are optional clients selected by an application. Both
are MIT licensed and neither is bundled. The exported helpers only adapt their
public `eval` call shapes.

Redis server licensing depends on the selected server version. Connecting over
the Redis protocol does not bundle the server with this package. Applications
that redistribute a server, container image, client, or modified third-party
source should review and preserve the corresponding license terms and notices.

No third-party source or documentation text is vendored in this repository.
