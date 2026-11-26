# PresentMon

This package redistributes the unmodified Intel-signed PresentMon v2.5.1 x64 console binary from the [upstream release](https://github.com/GameTechDev/PresentMon/releases/tag/v2.5.1). It is licensed under the terms in [LICENSE-PresentMon.txt](LICENSE-PresentMon.txt). The build checks the release asset's SHA-256 and the publisher's Authenticode signature.

The FPS button reads the console's frame metrics with Windows Event Tracing. The plugin can use this source when Stream Dock is running with administrative rights or the Windows account has access through the local **Performance Log Users** group. See the [upstream permission requirements](https://github.com/GameTechDev/PresentMon/tree/v2.5.1#user-access-denied).

The collector accepts selected executable names and keeps roughly one second of samples in memory. It does not create trace files or modify games. It stops its own capture when the last FPS key is hidden.
