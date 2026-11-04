/**
 * WORKLOAD CLASSIFIER & HARDWARE NORMALIZATION ENGINE
 * 
 * Classifies 16 workload categories:
 * - LLM inference, LLM training
 * - image generation, video generation
 * - Stable Diffusion, Whisper, embedding generation
 * - batch inference, fine tuning
 * - rendering, Blender, 3D rendering
 * - CUDA compute, scientific compute, crypto/allowed compute
 * - CPU workload, GPU benchmark
 * 
 * Hardware Normalization:
 * Evaluates VRAM, CUDA capability, FP16/BF16/FP32, Tensor TFLOPS, Memory Bandwidth (GB/s),
 * and Benchmark scores to ensure realistic parity matching.
 */

export type WorkloadCategory =
  | 'LLM_INFERENCE'
  | 'LLM_TRAINING'
  | 'IMAGE_GENERATION'
  | 'VIDEO_GENERATION'
  | 'STABLE_DIFFUSION'
  | 'WHISPER'
  | 'EMBEDDING_GENERATION'
  | 'BATCH_INFERENCE'
  | 'FINE_TUNING'
  | 'RENDERING'
  | 'BLENDER'
  | 'THREE_D_RENDERING'
  | 'CUDA_COMPUTE'
  | 'SCIENTIFIC_COMPUTE'
  | 'CRYPTO_ALLOWED_COMPUTE'
  | 'CPU_WORKLOAD'
  | 'GPU_BENCHMARK';

export interface NormalizedGpuSpec {
  canonicalName: string;
  aliases: string[];
  vramGb: number;
  cudaComputeCapability: number; // e.g. 8.9 for Ada Lovelace, 9.0 for Hopper, 8.0 for Ampere
  fp16Tflops: number;
  bf16Tflops: number;
  fp32Tflops: number;
  tensorTflops: number;
  memoryBandwidthGbps: number;
  benchmarkScore: number; // Normalized synthetic compute index
  interconnect: 'PCIe' | 'SXM4' | 'SXM5' | 'NVLink';
  supportedWorkloads: WorkloadCategory[];
}

export const NORMALIZED_GPU_CATALOG: Record<string, NormalizedGpuSpec> = {
  'H100': {
    canonicalName: 'H100',
    aliases: ['H100 SXM5 80GB', 'NVIDIA H100 80GB HBM3', 'H100 PCIe', 'NVIDIA H100', 'HGX H100'],
    vramGb: 80,
    cudaComputeCapability: 9.0,
    fp16Tflops: 989,
    bf16Tflops: 989,
    fp32Tflops: 67,
    tensorTflops: 1979,
    memoryBandwidthGbps: 3350,
    benchmarkScore: 100,
    interconnect: 'SXM5',
    supportedWorkloads: [
      'LLM_TRAINING', 'LLM_INFERENCE', 'FINE_TUNING', 'SCIENTIFIC_COMPUTE',
      'CUDA_COMPUTE', 'BATCH_INFERENCE', 'VIDEO_GENERATION', 'GPU_BENCHMARK'
    ]
  },
  'H200': {
    canonicalName: 'H200',
    aliases: ['H200 141GB', 'NVIDIA H200', 'H200 SXM'],
    vramGb: 141,
    cudaComputeCapability: 9.0,
    fp16Tflops: 989,
    bf16Tflops: 989,
    fp32Tflops: 67,
    tensorTflops: 1979,
    memoryBandwidthGbps: 4800,
    benchmarkScore: 115,
    interconnect: 'SXM5',
    supportedWorkloads: [
      'LLM_TRAINING', 'LLM_INFERENCE', 'FINE_TUNING', 'SCIENTIFIC_COMPUTE',
      'CUDA_COMPUTE', 'BATCH_INFERENCE', 'VIDEO_GENERATION', 'GPU_BENCHMARK'
    ]
  },
  'B200': {
    canonicalName: 'B200',
    aliases: ['Blackwell B200', 'NVIDIA B200 192GB'],
    vramGb: 192,
    cudaComputeCapability: 10.0,
    fp16Tflops: 2250,
    bf16Tflops: 2250,
    fp32Tflops: 120,
    tensorTflops: 4500,
    memoryBandwidthGbps: 8000,
    benchmarkScore: 210,
    interconnect: 'NVLink',
    supportedWorkloads: [
      'LLM_TRAINING', 'LLM_INFERENCE', 'FINE_TUNING', 'SCIENTIFIC_COMPUTE',
      'CUDA_COMPUTE', 'BATCH_INFERENCE', 'GPU_BENCHMARK'
    ]
  },
  'A100_80GB': {
    canonicalName: 'A100 80GB',
    aliases: ['A100 SXM4 80GB', 'NVIDIA A100-SXM4-80GB', 'A100 80GB PCIe', 'HGX A100 80GB'],
    vramGb: 80,
    cudaComputeCapability: 8.0,
    fp16Tflops: 312,
    bf16Tflops: 312,
    fp32Tflops: 19.5,
    tensorTflops: 624,
    memoryBandwidthGbps: 2039,
    benchmarkScore: 68,
    interconnect: 'SXM4',
    supportedWorkloads: [
      'LLM_TRAINING', 'LLM_INFERENCE', 'FINE_TUNING', 'SCIENTIFIC_COMPUTE',
      'CUDA_COMPUTE', 'BATCH_INFERENCE', 'EMBEDDING_GENERATION', 'VIDEO_GENERATION'
    ]
  },
  'A100_40GB': {
    canonicalName: 'A100 40GB',
    aliases: ['A100 PCIe 40GB', 'NVIDIA A100-PCIE-40GB'],
    vramGb: 40,
    cudaComputeCapability: 8.0,
    fp16Tflops: 312,
    bf16Tflops: 312,
    fp32Tflops: 19.5,
    tensorTflops: 624,
    memoryBandwidthGbps: 1555,
    benchmarkScore: 58,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'LLM_INFERENCE', 'FINE_TUNING', 'CUDA_COMPUTE', 'BATCH_INFERENCE', 'EMBEDDING_GENERATION'
    ]
  },
  'L40S': {
    canonicalName: 'L40S',
    aliases: ['NVIDIA L40S', 'L40S 48GB'],
    vramGb: 48,
    cudaComputeCapability: 8.9,
    fp16Tflops: 366,
    bf16Tflops: 366,
    fp32Tflops: 91.6,
    tensorTflops: 733,
    memoryBandwidthGbps: 864,
    benchmarkScore: 64,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'IMAGE_GENERATION', 'VIDEO_GENERATION', 'LLM_INFERENCE', 'RENDERING',
      'BLENDER', 'THREE_D_RENDERING', 'FINE_TUNING'
    ]
  },
  'L40': {
    canonicalName: 'L40',
    aliases: ['NVIDIA L40', 'L40 48GB'],
    vramGb: 48,
    cudaComputeCapability: 8.9,
    fp16Tflops: 181,
    bf16Tflops: 181,
    fp32Tflops: 90.5,
    tensorTflops: 362,
    memoryBandwidthGbps: 864,
    benchmarkScore: 52,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'RENDERING', 'BLENDER', 'THREE_D_RENDERING', 'IMAGE_GENERATION', 'LLM_INFERENCE'
    ]
  },
  'RTX_4090': {
    canonicalName: 'RTX 4090',
    aliases: ['RTX 4090 24GB', 'NVIDIA GeForce RTX 4090', 'GeForce RTX 4090'],
    vramGb: 24,
    cudaComputeCapability: 8.9,
    fp16Tflops: 165,
    bf16Tflops: 165,
    fp32Tflops: 82.6,
    tensorTflops: 330,
    memoryBandwidthGbps: 1008,
    benchmarkScore: 48,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'STABLE_DIFFUSION', 'IMAGE_GENERATION', 'WHISPER', 'LLM_INFERENCE',
      'RENDERING', 'BLENDER', 'THREE_D_RENDERING', 'EMBEDDING_GENERATION'
    ]
  },
  'RTX_3090': {
    canonicalName: 'RTX 3090',
    aliases: ['RTX 3090 24GB', 'NVIDIA GeForce RTX 3090'],
    vramGb: 24,
    cudaComputeCapability: 8.6,
    fp16Tflops: 71,
    bf16Tflops: 71,
    fp32Tflops: 35.6,
    tensorTflops: 142,
    memoryBandwidthGbps: 936,
    benchmarkScore: 32,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'STABLE_DIFFUSION', 'IMAGE_GENERATION', 'WHISPER', 'EMBEDDING_GENERATION',
      'RENDERING', 'BLENDER'
    ]
  },
  'A6000': {
    canonicalName: 'A6000',
    aliases: ['RTX A6000', 'NVIDIA RTX A6000 48GB', 'RTX 6000 Ada'],
    vramGb: 48,
    cudaComputeCapability: 8.6,
    fp16Tflops: 154,
    bf16Tflops: 154,
    fp32Tflops: 38.7,
    tensorTflops: 309,
    memoryBandwidthGbps: 768,
    benchmarkScore: 44,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'RENDERING', 'BLENDER', 'THREE_D_RENDERING', 'LLM_INFERENCE', 'FINE_TUNING'
    ]
  },
  'A5000': {
    canonicalName: 'A5000',
    aliases: ['RTX A5000', 'RTX A5000 24GB', 'NVIDIA RTX A5000'],
    vramGb: 24,
    cudaComputeCapability: 8.6,
    fp16Tflops: 111,
    bf16Tflops: 111,
    fp32Tflops: 27.8,
    tensorTflops: 222,
    memoryBandwidthGbps: 768,
    benchmarkScore: 30,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'RENDERING', 'BLENDER', 'STABLE_DIFFUSION', 'IMAGE_GENERATION', 'EMBEDDING_GENERATION'
    ]
  },
  'A4000': {
    canonicalName: 'A4000',
    aliases: ['RTX A4000', 'RTX A4000 16GB', 'NVIDIA RTX A4000'],
    vramGb: 16,
    cudaComputeCapability: 8.6,
    fp16Tflops: 77,
    bf16Tflops: 77,
    fp32Tflops: 19.2,
    tensorTflops: 153,
    memoryBandwidthGbps: 448,
    benchmarkScore: 22,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'WHISPER', 'EMBEDDING_GENERATION', 'STABLE_DIFFUSION', 'BATCH_INFERENCE'
    ]
  },
  'A40': {
    canonicalName: 'A40',
    aliases: ['NVIDIA A40', 'A40 48GB'],
    vramGb: 48,
    cudaComputeCapability: 8.6,
    fp16Tflops: 150,
    bf16Tflops: 150,
    fp32Tflops: 37.4,
    tensorTflops: 299,
    memoryBandwidthGbps: 696,
    benchmarkScore: 42,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'RENDERING', 'BLENDER', 'LLM_INFERENCE', 'IMAGE_GENERATION', 'FINE_TUNING'
    ]
  },
  'V100': {
    canonicalName: 'V100',
    aliases: ['Tesla V100', 'NVIDIA V100 16GB', 'NVIDIA V100 32GB', 'V100 SXM2'],
    vramGb: 32,
    cudaComputeCapability: 7.0,
    fp16Tflops: 125,
    bf16Tflops: 0, // V100 lacks BF16
    fp32Tflops: 15.7,
    tensorTflops: 125,
    memoryBandwidthGbps: 900,
    benchmarkScore: 24,
    interconnect: 'PCIe',
    supportedWorkloads: [
      'CUDA_COMPUTE', 'SCIENTIFIC_COMPUTE', 'BATCH_INFERENCE'
    ]
  }
};

export interface WorkloadRequirement {
  category: WorkloadCategory;
  minVramGb: number;
  minCudaCapability: number;
  requiresBf16: boolean;
  minMemoryBandwidthGbps: number;
  recommendedGpu: string;
  acceptableGpuModels: string[];
  interruptionToleranceDefault: 'STRICT_NO_INTERRUPTIONS' | 'CHECKPOINTABLE_BATCH' | 'LOW_PRIORITY_FAULT_TOLERANT';
}

export const WORKLOAD_REQUIREMENTS: Record<WorkloadCategory, WorkloadRequirement> = {
  'LLM_TRAINING': {
    category: 'LLM_TRAINING',
    minVramGb: 80,
    minCudaCapability: 8.0,
    requiresBf16: true,
    minMemoryBandwidthGbps: 2000,
    recommendedGpu: 'H100',
    acceptableGpuModels: ['H100', 'H200', 'B200', 'A100 80GB'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'LLM_INFERENCE': {
    category: 'LLM_INFERENCE',
    minVramGb: 24,
    minCudaCapability: 8.0,
    requiresBf16: false,
    minMemoryBandwidthGbps: 800,
    recommendedGpu: 'A100 80GB',
    acceptableGpuModels: ['H100', 'A100 80GB', 'A100 40GB', 'L40S', 'A6000', 'RTX 4090'],
    interruptionToleranceDefault: 'STRICT_NO_INTERRUPTIONS'
  },
  'FINE_TUNING': {
    category: 'FINE_TUNING',
    minVramGb: 48,
    minCudaCapability: 8.0,
    requiresBf16: true,
    minMemoryBandwidthGbps: 800,
    recommendedGpu: 'A100 80GB',
    acceptableGpuModels: ['H100', 'A100 80GB', 'L40S', 'A6000', 'A40'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'IMAGE_GENERATION': {
    category: 'IMAGE_GENERATION',
    minVramGb: 16,
    minCudaCapability: 8.6,
    requiresBf16: false,
    minMemoryBandwidthGbps: 600,
    recommendedGpu: 'RTX 4090',
    acceptableGpuModels: ['RTX 4090', 'RTX 3090', 'L40S', 'A5000', 'A4000'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'VIDEO_GENERATION': {
    category: 'VIDEO_GENERATION',
    minVramGb: 24,
    minCudaCapability: 8.9,
    requiresBf16: true,
    minMemoryBandwidthGbps: 800,
    recommendedGpu: 'H100',
    acceptableGpuModels: ['H100', 'A100 80GB', 'L40S', 'RTX 4090'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'STABLE_DIFFUSION': {
    category: 'STABLE_DIFFUSION',
    minVramGb: 16,
    minCudaCapability: 8.6,
    requiresBf16: false,
    minMemoryBandwidthGbps: 600,
    recommendedGpu: 'RTX 4090',
    acceptableGpuModels: ['RTX 4090', 'RTX 3090', 'A5000', 'A4000'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'WHISPER': {
    category: 'WHISPER',
    minVramGb: 12,
    minCudaCapability: 7.5,
    requiresBf16: false,
    minMemoryBandwidthGbps: 400,
    recommendedGpu: 'A4000',
    acceptableGpuModels: ['A4000', 'RTX 3090', 'RTX 4090', 'A5000'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'EMBEDDING_GENERATION': {
    category: 'EMBEDDING_GENERATION',
    minVramGb: 16,
    minCudaCapability: 8.0,
    requiresBf16: false,
    minMemoryBandwidthGbps: 400,
    recommendedGpu: 'A4000',
    acceptableGpuModels: ['A4000', 'RTX 3090', 'RTX 4090', 'A100 40GB'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'BATCH_INFERENCE': {
    category: 'BATCH_INFERENCE',
    minVramGb: 16,
    minCudaCapability: 7.0,
    requiresBf16: false,
    minMemoryBandwidthGbps: 400,
    recommendedGpu: 'A4000',
    acceptableGpuModels: ['A4000', 'RTX 4090', 'RTX 3090', 'V100', 'A100 40GB'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'RENDERING': {
    category: 'RENDERING',
    minVramGb: 24,
    minCudaCapability: 8.6,
    requiresBf16: false,
    minMemoryBandwidthGbps: 600,
    recommendedGpu: 'RTX 4090',
    acceptableGpuModels: ['RTX 4090', 'RTX 3090', 'A6000', 'A5000', 'L40'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'BLENDER': {
    category: 'BLENDER',
    minVramGb: 16,
    minCudaCapability: 8.6,
    requiresBf16: false,
    minMemoryBandwidthGbps: 500,
    recommendedGpu: 'RTX 4090',
    acceptableGpuModels: ['RTX 4090', 'RTX 3090', 'A5000', 'L40', 'A4000'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'THREE_D_RENDERING': {
    category: 'THREE_D_RENDERING',
    minVramGb: 24,
    minCudaCapability: 8.6,
    requiresBf16: false,
    minMemoryBandwidthGbps: 600,
    recommendedGpu: 'RTX 4090',
    acceptableGpuModels: ['RTX 4090', 'A6000', 'L40', 'A5000'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'CUDA_COMPUTE': {
    category: 'CUDA_COMPUTE',
    minVramGb: 16,
    minCudaCapability: 7.0,
    requiresBf16: false,
    minMemoryBandwidthGbps: 500,
    recommendedGpu: 'A100 40GB',
    acceptableGpuModels: ['A100 40GB', 'A100 80GB', 'H100', 'V100', 'RTX 4090'],
    interruptionToleranceDefault: 'CHECKPOINTABLE_BATCH'
  },
  'SCIENTIFIC_COMPUTE': {
    category: 'SCIENTIFIC_COMPUTE',
    minVramGb: 32,
    minCudaCapability: 8.0,
    requiresBf16: true,
    minMemoryBandwidthGbps: 1000,
    recommendedGpu: 'A100 80GB',
    acceptableGpuModels: ['H100', 'A100 80GB', 'V100'],
    interruptionToleranceDefault: 'STRICT_NO_INTERRUPTIONS'
  },
  'CRYPTO_ALLOWED_COMPUTE': {
    category: 'CRYPTO_ALLOWED_COMPUTE',
    minVramGb: 16,
    minCudaCapability: 8.6,
    requiresBf16: false,
    minMemoryBandwidthGbps: 500,
    recommendedGpu: 'RTX 3090',
    acceptableGpuModels: ['RTX 3090', 'RTX 4090', 'A4000'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'CPU_WORKLOAD': {
    category: 'CPU_WORKLOAD',
    minVramGb: 0,
    minCudaCapability: 0,
    requiresBf16: false,
    minMemoryBandwidthGbps: 0,
    recommendedGpu: 'A4000',
    acceptableGpuModels: ['A4000'],
    interruptionToleranceDefault: 'LOW_PRIORITY_FAULT_TOLERANT'
  },
  'GPU_BENCHMARK': {
    category: 'GPU_BENCHMARK',
    minVramGb: 24,
    minCudaCapability: 8.9,
    requiresBf16: true,
    minMemoryBandwidthGbps: 1000,
    recommendedGpu: 'H100',
    acceptableGpuModels: ['H100', 'H200', 'A100 80GB', 'RTX 4090'],
    interruptionToleranceDefault: 'STRICT_NO_INTERRUPTIONS'
  }
};

/**
 * Classifies an incoming job string/spec into one of the 16 WorkloadCategory types
 */
export function classifyWorkload(rawWorkload: string): WorkloadRequirement {
  const norm = (rawWorkload || '').toUpperCase();

  if (norm.includes('LLM_TRAIN') || norm.includes('PRETRAIN') || norm.includes('DEEPSPEED')) {
    return WORKLOAD_REQUIREMENTS['LLM_TRAINING'];
  }
  if (norm.includes('FINE_TUNE') || norm.includes('LORA') || norm.includes('QLORA') || norm.includes('PEFT')) {
    return WORKLOAD_REQUIREMENTS['FINE_TUNING'];
  }
  if (norm.includes('VIDEO_GEN') || norm.includes('SORA') || norm.includes('ANIMATE') || norm.includes('RUNWAY')) {
    return WORKLOAD_REQUIREMENTS['VIDEO_GENERATION'];
  }
  if (norm.includes('STABLE_DIFFUSION') || norm.includes('SDXL') || norm.includes('DIFFUSION')) {
    return WORKLOAD_REQUIREMENTS['STABLE_DIFFUSION'];
  }
  if (norm.includes('IMAGE_GEN') || norm.includes('MIDJOURNEY') || norm.includes('DALL')) {
    return WORKLOAD_REQUIREMENTS['IMAGE_GENERATION'];
  }
  if (norm.includes('WHISPER') || norm.includes('SPEECH') || norm.includes('AUDIO') || norm.includes('TRANSCRIBE')) {
    return WORKLOAD_REQUIREMENTS['WHISPER'];
  }
  if (norm.includes('EMBED') || norm.includes('VECTOR') || norm.includes('RAG')) {
    return WORKLOAD_REQUIREMENTS['EMBEDDING_GENERATION'];
  }
  if (norm.includes('BLENDER')) {
    return WORKLOAD_REQUIREMENTS['BLENDER'];
  }
  if (norm.includes('3D') || norm.includes('THREE_D') || norm.includes('MAYA') || norm.includes('UNREAL')) {
    return WORKLOAD_REQUIREMENTS['THREE_D_RENDERING'];
  }
  if (norm.includes('RENDER') || norm.includes('OCTANE') || norm.includes('VRAY')) {
    return WORKLOAD_REQUIREMENTS['RENDERING'];
  }
  if (norm.includes('SCIENTIFIC') || norm.includes('PHYSICS') || norm.includes('SIMULATION') || norm.includes('GROMACS')) {
    return WORKLOAD_REQUIREMENTS['SCIENTIFIC_COMPUTE'];
  }
  if (norm.includes('CRYPTO') || norm.includes('HASH') || norm.includes('MINING')) {
    return WORKLOAD_REQUIREMENTS['CRYPTO_ALLOWED_COMPUTE'];
  }
  if (norm.includes('BENCHMARK') || norm.includes('BURNIN') || norm.includes('STRESS')) {
    return WORKLOAD_REQUIREMENTS['GPU_BENCHMARK'];
  }
  if (norm.includes('BATCH')) {
    return WORKLOAD_REQUIREMENTS['BATCH_INFERENCE'];
  }
  if (norm.includes('CPU')) {
    return WORKLOAD_REQUIREMENTS['CPU_WORKLOAD'];
  }
  // Default to LLM_INFERENCE
  return WORKLOAD_REQUIREMENTS['LLM_INFERENCE'];
}

/**
 * Normalizes a raw GPU string to a canonical NormalizedGpuSpec
 */
export function normalizeGpu(rawName: string): NormalizedGpuSpec | null {
  const norm = (rawName || '').trim().toUpperCase();

  for (const key of Object.keys(NORMALIZED_GPU_CATALOG)) {
    const spec = NORMALIZED_GPU_CATALOG[key];
    if (norm === spec.canonicalName.toUpperCase() || norm === key) {
      return spec;
    }
    for (const alias of spec.aliases) {
      if (norm.includes(alias.toUpperCase())) {
        return spec;
      }
    }
  }

  // Fallback checks
  if (norm.includes('4090')) return NORMALIZED_GPU_CATALOG['RTX_4090'];
  if (norm.includes('3090')) return NORMALIZED_GPU_CATALOG['RTX_3090'];
  if (norm.includes('H100')) return NORMALIZED_GPU_CATALOG['H100'];
  if (norm.includes('H200')) return NORMALIZED_GPU_CATALOG['H200'];
  if (norm.includes('B200')) return NORMALIZED_GPU_CATALOG['B200'];
  if (norm.includes('A100') && norm.includes('80')) return NORMALIZED_GPU_CATALOG['A100_80GB'];
  if (norm.includes('A100')) return NORMALIZED_GPU_CATALOG['A100_40GB'];
  if (norm.includes('L40S')) return NORMALIZED_GPU_CATALOG['L40S'];
  if (norm.includes('L40')) return NORMALIZED_GPU_CATALOG['L40'];
  if (norm.includes('A6000')) return NORMALIZED_GPU_CATALOG['A6000'];
  if (norm.includes('A5000')) return NORMALIZED_GPU_CATALOG['A5000'];
  if (norm.includes('A4000')) return NORMALIZED_GPU_CATALOG['A4000'];
  if (norm.includes('A40')) return NORMALIZED_GPU_CATALOG['A40'];
  if (norm.includes('V100')) return NORMALIZED_GPU_CATALOG['V100'];

  return null;
}
