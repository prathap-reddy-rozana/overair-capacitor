require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'OverairCapacitor'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/prathap-reddy-rozana/overair-capacitor'
  s.author = 'Overair'
  s.source = { :git => 'https://github.com/prathap-reddy-rozana/overair-capacitor.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'ZIPFoundation', '~> 0.9'
  s.swift_version = '5.9'
end
