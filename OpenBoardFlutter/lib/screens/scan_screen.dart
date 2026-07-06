import 'dart:io';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/api_service.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final MobileScannerController _scannerController = MobileScannerController(
    detectionSpeed: DetectionSpeed.normal,
    facing: CameraFacing.back,
  );

  bool _isScanning = true;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (!_isScanning) return;

    final List<Barcode> barcodes = capture.barcodes;
    if (barcodes.isNotEmpty) {
      final String? code = barcodes.first.rawValue;
      if (code != null && code.isNotEmpty) {
        _isScanning = false;
        Navigator.pop(context, code);
      }
    }
  }

  Future<void> _scanFromGallery() async {
    final ImagePicker picker = ImagePicker();
    final XFile? image = await picker.pickImage(source: ImageSource.gallery);
    if (image == null) return;

    setState(() {
      _isScanning = false;
    });

    try {
      // Decode image QR using ApiService's ZXing implementation
      final String? result = await _decodeQrCodeFromFile(image.path);
      if (result != null && result.isNotEmpty) {
        if (mounted) {
          Navigator.pop(context, result);
        }
      } else {
        _showError('未在图片中识别到二维码');
        setState(() {
          _isScanning = true;
        });
      }
    } catch (e) {
      _showError('解析图片失败: $e');
      setState(() {
        _isScanning = true;
      });
    }
  }

  // Pure Dart helper that reads bytes and decodes QR using pure zxing wrapper if possible
  // In standard flutter, we can also use native packages or pass to mobile_scanner,
  // but since mobile_scanner has decodeImageFile:
  Future<String?> _decodeQrCodeFromFile(String filePath) async {
    try {
      final BarcodeCapture? capture = await _scannerController.analyzeImage(filePath);
      if (capture != null && capture.barcodes.isNotEmpty) {
        return capture.barcodes.first.rawValue;
      }
    } catch (e) {
      print('Analyze image error: $e');
    }
    return null;
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Colors.red.shade700,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('扫描二维码', style: TextStyle(color: Colors.white)),
        backgroundColor: Colors.blue.shade800,
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(
            icon: const Icon(Icons.photo_library),
            tooltip: '从相册选择',
            onPressed: _scanFromGallery,
          ),
          IconButton(
            icon: ValueListenableBuilder<MobileScannerState>(
              valueListenable: _scannerController,
              builder: (context, state, child) {
                switch (state.torchState) {
                  case TorchState.on:
                    return const Icon(Icons.flash_on);
                  case TorchState.off:
                  default:
                    return const Icon(Icons.flash_off);
                }
              },
            ),
            onPressed: () => _scannerController.toggleTorch(),
          ),
        ],
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _scannerController,
            onDetect: _onDetect,
            errorBuilder: (context, error, child) {
              return Center(
                child: Container(
                  padding: const EdgeInsets.all(24.0),
                  margin: const EdgeInsets.all(24.0),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.error_outline, color: Colors.red, size: 48),
                      const SizedBox(height: 12),
                      const Text(
                        '无法启动相机扫码',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '可能是权限不足或模拟器没有物理摄像头。请尝试从相册选择图片，或返回手动输入。',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey.shade600),
                      ),
                      const SizedBox(height: 16),
                      ElevatedButton(
                        onPressed: _scanFromGallery,
                        child: const Text('从相册选择图片'),
                      )
                    ],
                  ),
                ),
              );
            },
          ),
          // Scanner Overlay Mask
          Positioned.fill(
            child: Container(
              decoration: ShapeDecoration(
                shape: QrScannerOverlayShape(
                  borderColor: Colors.blue.shade600,
                  borderRadius: 12,
                  borderLength: 24,
                  borderWidth: 4,
                  cutOutSize: 260,
                ),
              ),
            ),
          ),
          const Positioned(
            bottom: 60.0,
            left: 0.0,
            right: 0.0,
            child: Text(
              '请将二维码放入框内即可自动扫描',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.white70,
                fontSize: 13.0,
                shadows: [Shadow(color: Colors.black45, blurRadius: 4.0)],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// Custom scanner overlay shape painter
class QrScannerOverlayShape extends ShapeBorder {
  final Color borderColor;
  final double borderWidth;
  final double borderLength;
  final double borderRadius;
  final double cutOutSize;

  const QrScannerOverlayShape({
    this.borderColor = Colors.blue,
    this.borderWidth = 3.0,
    this.borderLength = 20.0,
    this.borderRadius = 8.0,
    this.cutOutSize = 240.0,
  });

  @override
  EdgeInsetsGeometry get dimensions => EdgeInsets.zero;

  @override
  Path getInnerPath(Rect rect, {TextDirection? textDirection}) => Path();

  @override
  Path getOuterPath(Rect rect, {TextDirection? textDirection}) {
    return Path()..addRect(rect);
  }

  @override
  void paint(Canvas canvas, Rect rect, {TextDirection? textDirection}) {
    final width = rect.width;
    final height = rect.height;

    final Paint maskPaint = Paint()
      ..color = Colors.black.withOpacity(0.5)
      ..style = PaintingStyle.fill;

    // Cutout rect in center
    final cutoutRect = Rect.fromCenter(
      center: Offset(width / 2, height / 2),
      width: cutOutSize,
      height: cutOutSize,
    );

    // Draw overlay mask with cutout
    canvas.drawPath(
      Path.combine(
        PathOp.difference,
        Path()..addRect(rect),
        Path()..addRRect(RRect.fromRectAndRadius(cutoutRect, Radius.circular(borderRadius))),
      ),
      maskPaint,
    );

    // Paint Border corners
    final Paint borderPaint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = borderWidth;

    final rrect = RRect.fromRectAndRadius(cutoutRect, Radius.circular(borderRadius));

    // Top Left
    canvas.drawPath(
      Path()
        ..moveTo(rrect.left, rrect.top + borderLength)
        ..lineTo(rrect.left, rrect.top + borderRadius)
        ..quadraticBezierTo(rrect.left, rrect.top, rrect.left + borderRadius, rrect.top)
        ..lineTo(rrect.left + borderLength, rrect.top),
      borderPaint,
    );

    // Top Right
    canvas.drawPath(
      Path()
        ..moveTo(rrect.right - borderLength, rrect.top)
        ..lineTo(rrect.right - borderRadius, rrect.top)
        ..quadraticBezierTo(rrect.right, rrect.top, rrect.right, rrect.top + borderRadius)
        ..lineTo(rrect.right, rrect.top + borderLength),
      borderPaint,
    );

    // Bottom Left
    canvas.drawPath(
      Path()
        ..moveTo(rrect.left, rrect.bottom - borderLength)
        ..lineTo(rrect.left, rrect.bottom - borderRadius)
        ..quadraticBezierTo(rrect.left, rrect.bottom, rrect.left + borderRadius, rrect.bottom)
        ..lineTo(rrect.left + borderLength, rrect.bottom),
      borderPaint,
    );

    // Bottom Right
    canvas.drawPath(
      Path()
        ..moveTo(rrect.right - borderLength, rrect.bottom)
        ..lineTo(rrect.right - borderRadius, rrect.bottom)
        ..quadraticBezierTo(rrect.right, rrect.bottom, rrect.right, rrect.bottom - borderRadius)
        ..lineTo(rrect.right, rrect.bottom - borderLength),
      borderPaint,
    );
  }

  @override
  ShapeBorder scale(double t) => this;
}
