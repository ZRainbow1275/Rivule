# Cumulative task-navigation checkpoint

The private cumulative workbench now supports returning from a selected child task to its parent, retaining up to 20 ancestor levels. Navigation uses the same already-read task snapshot and adds no requests or data writes. The existing return-to-attention-overview action remains available.

This feature depends on the cumulative task-detail implementation, which is not present in the public source baseline. This checkpoint does not replace public implementation files.

Persistent overlay: `Rivule-cumulative-navigation-overlay-20261118.zip` in the owner's Library. Includes the cumulative adaptations for search normalization, whole-character appearance persistence, task-filter recovery, and parent navigation. Restore over the verified `Rivule-cumulative-workbench-16fix-20261118.tar.gz` source only after checking the baseline hash in its manifest.

Overlay SHA-256: `8f7ed267c563d28717bbc6901916d650f26f7a16d4202083676e1b3564f5a33d` (61,055 bytes).

Validation: 185 targeted offline tests pass. Four new parent-navigation reproductions failed before the change and pass afterward. No deployment or native-browser acceptance was performed.
