# Sculptio

Sculptio is a decentralized, peer-to-peer multi-player 3D modeling and guessing game built with Electron, React, and WebGPU.

One player sculpts a 3D model in real-time, while other players try to guess what is being modeled.

Players share or join rooms via the distributed network.

3D models are created using a WebGPU implementation of the Marching Cubes algorithm. 

## Screenshots

<img width="1920" height="1032" alt="Sculptio Gameplay" src="https://github.com/user-attachments/assets/e582845e-bdd1-420c-8b74-9f3d7c85fa87" />



## Network & Privacy Notice

Sculptio operates on a completely decentralized architecture utilizing a distributed **DHT network** to discover peers and establish **direct connections** without relying on a centralized backend server. 

Please be aware of the following:
* **IP Visibility:** Because connections are peer-to-peer, your public IP address will be visible to other players who connect to your room, as well as to random nodes assisting in the network hole-punching process.
* **VPN Recommendation:** If you require absolute privacy and wish to hide your residential IP address from other peers on the network, it is highly recommended to run a **VPN (Virtual Private Network)** while playing the game.


## How to Build from Source

You can build Sculptio locally for Windows, macOS, or Linux. Please ensure you have [Node.js](https://nodejs.org/) installed on your system before proceeding.

### 1. Install Dependencies
Clone the repository, navigate to the project root, and install the required npm packages:
```bash
npm install
```

### 2. Compile and Build for Your Platform
Run the appropriate build script depending on your target operating system. 

#### For Windows (Produces a Portable executable):
```bash
npm run build:win
```

#### For macOS (Produces a standalone ZIP package):
```bash
npm run build:mac
```

#### For Linux (Produces a standalone AppImage):
```bash
npm run build:linux
```

After the build process completes successfully, you will find the generated standalone binaries inside the **`dist/`** directory.

---

## License

This project is licensed under the **PolyForm Shield License 1.0.0**. 
